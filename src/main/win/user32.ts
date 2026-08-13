/**
 * The Windows API surface this app needs, through koffi.
 *
 * ONE FFI dependency, deliberately. The alternatives were all worse on a path that
 * runs per clipboard event: `get-windows` spawns an executable for every call,
 * robotjs/nut-js are unmaintained native addons that need a compiler, and PowerShell
 * costs ~200ms of process start. koffi is N-API with prebuilt win32-x64 and
 * win32-arm64 binaries, so `pnpm install` needs no toolchain — which is the same
 * property every other native dependency in this project already has, and the reason
 * a Windows CI install can be green without node-gyp.
 *
 * Everything here is lazy and fallible. koffi is loaded on first use, inside a
 * try/catch, and every function returns a null/undefined rather than throwing: an
 * anti-virus product that blocks the addon, or an arm64 machine with a bad install,
 * must cost us the FEATURE and not the app.
 */
import { WIN32 } from '../platform'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Koffi = any

interface Api {
  GetForegroundWindow: () => unknown
  SetForegroundWindow: (hwnd: unknown) => boolean
  GetWindowThreadProcessId: (hwnd: unknown, pid: Uint32Array) => number
  AttachThreadInput: (from: number, to: number, attach: boolean) => boolean
  GetCurrentThreadId: () => number
  OpenProcess: (access: number, inherit: boolean, pid: number) => unknown
  QueryFullProcessImageNameW: (
    proc: unknown,
    flags: number,
    name: Uint16Array,
    size: Uint32Array
  ) => boolean
  CloseHandle: (h: unknown) => boolean
  SendInput: (count: number, inputs: Uint8Array, size: number) => number
  GetAsyncKeyState: (vk: number) => number
  GetLastError: () => number
  koffi: Koffi
}

/** PROCESS_QUERY_LIMITED_INFORMATION — the least we can ask for and still get a path. */
export const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000

let api: Api | null | undefined

export function win32Api(): Api | null {
  if (api !== undefined) return api
  if (!WIN32) return (api = null)
  try {
    // Required at call time, not imported: bundling it would make every platform's
    // main bundle depend on a native addon that only Windows has a binary for.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi: Koffi = require('koffi')
    const user32 = koffi.load('user32.dll')
    const kernel32 = koffi.load('kernel32.dll')
    // `__stdcall` is ignored on x64 (there is only one calling convention there) and
    // is load-bearing on ia32. Naming it costs nothing and stops a 32-bit build from
    // corrupting its stack on every call.
    api = {
      GetForegroundWindow: user32.func('__stdcall', 'GetForegroundWindow', 'void *', []),
      SetForegroundWindow: user32.func('__stdcall', 'SetForegroundWindow', 'bool', ['void *']),
      GetWindowThreadProcessId: user32.func('__stdcall', 'GetWindowThreadProcessId', 'uint32', [
        'void *',
        koffi.out(koffi.pointer('uint32'))
      ]),
      AttachThreadInput: user32.func('__stdcall', 'AttachThreadInput', 'bool', [
        'uint32',
        'uint32',
        'bool'
      ]),
      GetCurrentThreadId: kernel32.func('__stdcall', 'GetCurrentThreadId', 'uint32', []),
      OpenProcess: kernel32.func('__stdcall', 'OpenProcess', 'void *', ['uint32', 'bool', 'uint32']),
      QueryFullProcessImageNameW: kernel32.func('__stdcall', 'QueryFullProcessImageNameW', 'bool', [
        'void *',
        'uint32',
        koffi.out(koffi.pointer('uint16')),
        koffi.inout(koffi.pointer('uint32'))
      ]),
      CloseHandle: kernel32.func('__stdcall', 'CloseHandle', 'bool', ['void *']),
      SendInput: user32.func('__stdcall', 'SendInput', 'uint32', ['uint32', 'void *', 'int32']),
      GetAsyncKeyState: user32.func('__stdcall', 'GetAsyncKeyState', 'int16', ['int32']),
      GetLastError: kernel32.func('__stdcall', 'GetLastError', 'uint32', []),
      koffi
    }
    return api
  } catch (err) {
    // Blocked by EDR, a missing prebuild, a 32-bit/64-bit mismatch: all of them mean
    // the same thing to the caller, and none of them may take the app down.
    console.error('[win] koffi unavailable; foreground-window and paste injection are off:', err)
    return (api = null)
  }
}

/** Decode a UTF-16 buffer up to its first NUL. */
export function decodeWide(buf: Uint16Array): string {
  const end = buf.indexOf(0)
  return String.fromCharCode(...buf.subarray(0, end === -1 ? buf.length : end))
}

/**
 * Just the executable's file name, lowercased: `1password.exe`, `code.exe`.
 *
 * Lowercased because Windows paths are case-insensitive and the ignore list is
 * matched as a substring — `C:\Program Files\1Password\1Password.exe` and
 * `...\1password.exe` are the same program, and a user's ignore entry is going to be
 * typed in whichever case they remember.
 */
export function exeBasename(fullPath: string): string {
  const cut = Math.max(fullPath.lastIndexOf('\\'), fullPath.lastIndexOf('/'))
  return fullPath.slice(cut + 1).toLowerCase()
}

/** The foreground window's handle, or null. */
export function foregroundWindow(): unknown | null {
  const w = win32Api()
  if (!w) return null
  try {
    const hwnd = w.GetForegroundWindow()
    // A null HWND means no window is foreground — happens during a desktop switch,
    // on the lock screen, and for a second or two after a full-screen app exits.
    return hwnd ? hwnd : null
  } catch {
    return null
  }
}

/** Full image path of the process owning a window, e.g. `C:\...\1Password.exe`. */
export function windowProcessPath(hwnd: unknown): string | null {
  const w = win32Api()
  if (!w || !hwnd) return null
  let proc: unknown = null
  try {
    const pid = new Uint32Array(1)
    w.GetWindowThreadProcessId(hwnd, pid)
    if (!pid[0]) return null
    // PROCESS_QUERY_LIMITED_INFORMATION rather than PROCESS_QUERY_INFORMATION: the
    // limited right is granted for higher-integrity and protected processes too, so
    // this still names an elevated editor or a password manager running as admin —
    // which are precisely the ones we most need to identify.
    proc = w.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid[0])
    if (!proc) return null
    const buf = new Uint16Array(520) // MAX_PATH is not a limit here; long paths exist
    const size = new Uint32Array([buf.length])
    if (!w.QueryFullProcessImageNameW(proc, 0, buf, size)) return null
    return decodeWide(buf.subarray(0, size[0]))
  } catch {
    return null
  } finally {
    if (proc) {
      try {
        // Leaking a process handle per clipboard event is a slow leak in a process
        // designed to run for weeks.
        w.CloseHandle(proc)
      } catch {
        /* already closed */
      }
    }
  }
}
