import { win32Api } from './user32'

/**
 * Sending the paste keystroke on Windows.
 *
 * `src/main/win/` is a third peer to `portal.ts` and `mac/helper.ts`, not a
 * reworking of either. In particular NOTHING here is ported from portal.ts: the
 * portal's partial-press retry machinery and latched-Ctrl recovery
 * (portal.ts:151-208) exist because the portal delivers keys one D-Bus call at a
 * time and can fail halfway through. SendInput takes the whole chord in one call and
 * the OS injects it atomically, so those failure modes cannot occur — and porting
 * the code that handles them would have carried the complexity without the cause.
 */

/** Virtual-key codes. NOT scan codes — see keyInputs(). */
export const VK = {
  SHIFT: 0x10,
  CONTROL: 0x11,
  MENU: 0x12, // Alt
  LWIN: 0x5b,
  RWIN: 0x5c,
  INSERT: 0x2d,
  V: 0x56
} as const

const INPUT_KEYBOARD = 1
const KEYEVENTF_KEYUP = 0x0002

/**
 * Size of one INPUT struct.
 *
 * x64: DWORD type (4) + 4 bytes of padding + a 32-byte union (MOUSEINPUT is the
 * largest member: five DWORDs then an 8-aligned ULONG_PTR) = 40.
 * x86: 4 + 24 = 28, with no padding anywhere.
 *
 * Getting this wrong does not throw. SendInput reads `cbSize` bytes per entry and
 * reports how many it "sent", so a struct that is too small sends garbage keys and
 * returns success. A CI test asserts the number against koffi's own sizeof.
 */
export function inputSize(pointerSize: number): number {
  return pointerSize === 8 ? 40 : 28
}

export interface KeyStroke {
  vk: number
  up?: boolean
}

/**
 * Pack a key sequence into the byte buffer SendInput expects.
 *
 * VIRTUAL-KEY codes, with wScan left at zero and no KEYEVENTF_SCANCODE. Scan codes
 * are physical positions: 0x2F is where V sits on a US QWERTY board, and on AZERTY
 * that key is `.` while on Dvorak it is `K`. Injecting a scan code would paste on
 * some layouts and type a full stop on others — the sort of bug that is reported as
 * "paste is broken on my machine" and cannot be reproduced anywhere else.
 */
export function keyInputs(strokes: KeyStroke[], pointerSize: number): Uint8Array {
  const size = inputSize(pointerSize)
  const buf = new Uint8Array(size * strokes.length)
  const view = new DataView(buf.buffer)
  strokes.forEach((s, i) => {
    const at = i * size
    // KEYBDINPUT begins after `type` plus the union's alignment padding.
    const kb = at + (pointerSize === 8 ? 8 : 4)
    view.setUint32(at, INPUT_KEYBOARD, true)
    view.setUint16(kb, s.vk, true) // wVk
    view.setUint16(kb + 2, 0, true) // wScan — unused with virtual keys
    view.setUint32(kb + 4, s.up ? KEYEVENTF_KEYUP : 0, true) // dwFlags
    view.setUint32(kb + 8, 0, true) // time: 0 means "stamp it yourself"
    // dwExtraInfo stays zero. It is left deliberately readable: an app that wants to
    // distinguish synthetic input can already do so via LLKHF_INJECTED, and tagging
    // ourselves here would achieve nothing but look like an attempt to hide.
  })
  return buf
}

/**
 * The paste chord for a destination.
 *
 * The Linux rule INVERTS here, and porting it verbatim would have broken exactly the
 * apps it was written to fix. On Linux terminals reserve Ctrl+V for the literal-next
 * escape and paste on Ctrl+Shift+V. On Windows conhost and Windows Terminal both
 * paste on plain Ctrl+V, and conhost ignores Ctrl+Shift+V entirely — so
 * "terminal ⇒ add Shift" would make terminals the one place paste silently fails
 * while the log says "injected".
 *
 * So: allowlist only, and everything not on it gets plain Ctrl+V. The allowlist is
 * the handful of emulators that genuinely do not take Ctrl+V, and they get
 * Shift+Insert rather than Ctrl+Shift+V — Shift+Insert works in conhost, Windows
 * Terminal, mintty and PuTTY alike, so a wrong guess still pastes.
 */
const SHIFT_INSERT_ONLY = new Set([
  // MSYS2/Git Bash and PuTTY are X-style terminals that never learned Ctrl+V.
  'mintty.exe',
  'putty.exe',
  'kitty.exe'
])

export function pasteStrokes(destExe: string | null): { strokes: KeyStroke[]; label: string } {
  const exe = destExe?.toLowerCase() ?? ''
  if (SHIFT_INSERT_ONLY.has(exe)) {
    return {
      strokes: [
        { vk: VK.SHIFT },
        { vk: VK.INSERT },
        { vk: VK.INSERT, up: true },
        { vk: VK.SHIFT, up: true }
      ],
      label: 'Shift+Insert'
    }
  }
  return {
    strokes: [
      { vk: VK.CONTROL },
      { vk: VK.V },
      { vk: VK.V, up: true },
      { vk: VK.CONTROL, up: true }
    ],
    label: 'Ctrl+V'
  }
}

/** Modifiers that must not be held while we inject, and the key-ups that clear them. */
export function strayModifierReleases(
  held: (vk: number) => boolean,
  about: KeyStroke[]
): KeyStroke[] {
  const wanted = new Set(about.map((s) => s.vk))
  const out: KeyStroke[] = []
  for (const vk of [VK.SHIFT, VK.CONTROL, VK.MENU, VK.LWIN, VK.RWIN]) {
    // Never release a modifier we are about to press — that is not a stray key, it
    // is our own chord, and clearing it first just costs a redundant event.
    if (wanted.has(vk)) continue
    // And never send a key-up for something that is not down. A blind LWIN key-up
    // POPS THE START MENU: Windows treats a Win key-up with no intervening key as a
    // Start invocation, so "defensively releasing modifiers" would open the Start
    // menu on top of the app we are pasting into, every single time.
    if (held(vk)) out.push({ vk, up: true })
  }
  return out
}

export interface InjectResult {
  injected: boolean
  /** Set when Windows refused the injection outright. */
  reason?: string
}

const ERROR_ACCESS_DENIED = 5

/**
 * Send one batched SendInput call.
 *
 * One call with all four events, not four calls: the OS guarantees a single
 * SendInput block cannot be interleaved with real keystrokes, so the user typing at
 * the same moment can never land a character between our Ctrl-down and our V.
 */
export function sendPaste(destExe: string | null): InjectResult {
  const w = win32Api()
  if (!w) return { injected: false, reason: 'the input library could not be loaded' }
  try {
    const { strokes, label } = pasteStrokes(destExe)
    const pointerSize = w.koffi.sizeof('void *') as number
    const all = [...strayModifierReleases((vk) => (w.GetAsyncKeyState(vk) & 0x8000) !== 0, strokes), ...strokes]
    const buf = keyInputs(all, pointerSize)
    const sent = w.SendInput(all.length, buf, inputSize(pointerSize))
    if (sent === all.length) {
      console.log(`[paste] injected ${label}${destExe ? ` → ${destExe}` : ''}`)
      return { injected: true }
    }
    // SendInput reports how many events it managed to send. Anything short means the
    // OS blocked us, and the ONLY interesting case is why.
    const err = w.GetLastError()
    if (err === ERROR_ACCESS_DENIED) {
      // UIPI: a process cannot send input to a window running at a higher integrity
      // level. That is not a bug to work around — it is the mechanism that stops a
      // normal app driving an elevated one — so we report it in the terms that let
      // the user decide, rather than as a generic "paste failed".
      return {
        injected: false,
        reason: 'Windows blocked the keystroke: the window you are pasting into runs as administrator. Run clipboard.md as administrator too, or paste with Ctrl+V.'
      }
    }
    return { injected: false, reason: `Windows accepted only ${sent} of ${all.length} keystrokes (error ${err}).` }
  } catch (err) {
    return { injected: false, reason: `input injection failed: ${String(err)}` }
  }
}
