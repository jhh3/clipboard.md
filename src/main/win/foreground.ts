import { exeBasename, foregroundWindow, win32Api, windowProcessPath } from './user32'

/**
 * Getting focus back to the app the user was in — the actually hard part of paste on
 * Windows, and the part with no counterpart in the existing code.
 *
 * On macOS the palette is a non-activating NSPanel: it never takes activation away,
 * so hiding it returns focus by itself and the frontmost app at paste time IS the
 * paste target. On Linux, mutter refocuses the previous surface when we hide. Windows
 * has neither — there is no non-activating panel, and no compositor handing focus
 * back — so the previous window has to be remembered before we steal focus and put
 * back afterwards, by us.
 *
 * Nothing in this codebase tracked "the previous app" before, because nothing needed
 * to.
 */

/** The window that had focus when we last summoned a surface of our own. */
let saved: unknown | null = null
let savedExe: string | null = null

/**
 * Record the foreground window. MUST be called BEFORE `win.show()`.
 *
 * After the show it is already too late — we are the foreground window, and the
 * thing we would remember is ourselves. Called from showPalette and
 * showDictationHud, which are the only two surfaces a paste ever follows.
 */
export function rememberForeground(): void {
  const hwnd = foregroundWindow()
  if (!hwnd) return // lock screen, desktop switch: keep the previous memory
  saved = hwnd
  const path = windowProcessPath(hwnd)
  savedExe = path ? exeBasename(path) : null
}

/**
 * The executable that will receive the paste, e.g. `code.exe`.
 *
 * Read from the REMEMBERED window rather than the current one, because by the time
 * anyone asks, the current one is us.
 */
export function targetExe(): string | null {
  return savedExe
}

const POLL_MS = 10
const SETTLE_CAP_MS = 250

/**
 * Put focus back where it was, and confirm it landed.
 *
 * Returns false if focus never arrives, and the caller MUST NOT inject when it does.
 * Firing Ctrl+V at an unknown window is the failure that produces "it pasted into
 * the wrong app" — or, worse, into a window where Ctrl+V means something else. A
 * clip left on the clipboard with a "press Ctrl+V" hint is a better outcome than a
 * keystroke sent somewhere nobody chose.
 *
 * The polled confirmation replaces the fixed sleep the other platforms use. A sleep
 * cannot tell "focus took 40ms" from "focus never came back", and on Windows the
 * second case is common: the foreground LOCK (SPI_GETFOREGROUNDLOCKTIMEOUT) makes
 * SetForegroundWindow silently return false-ish for a process that has not had
 * recent user input.
 */
export async function restoreForeground(): Promise<boolean> {
  const w = win32Api()
  if (!w || !saved) return false
  const target = w.koffi.address(saved)
  try {
    w.SetForegroundWindow(saved)
    if (await settled(w, target)) return true

    // The AttachThreadInput dance. Windows grants SetForegroundWindow to a thread
    // that shares an input queue with the current foreground thread, so attaching to
    // it briefly is the documented way an app that legitimately owns the interaction
    // gets focus back. Detached immediately: leaving the queues attached means our
    // message loop stalls whenever theirs does.
    const pid = new Uint32Array(1)
    const targetThread = w.GetWindowThreadProcessId(saved, pid)
    const self = w.GetCurrentThreadId()
    if (!targetThread || targetThread === self) return false
    w.AttachThreadInput(self, targetThread, true)
    try {
      w.SetForegroundWindow(saved)
    } finally {
      w.AttachThreadInput(self, targetThread, false)
    }
    return settled(w, target)
  } catch (err) {
    console.error('[paste] could not restore the previous window:', err)
    return false
  }
}

async function settled(w: NonNullable<ReturnType<typeof win32Api>>, target: unknown): Promise<boolean> {
  const deadline = Date.now() + SETTLE_CAP_MS
  while (Date.now() < deadline) {
    const now = w.GetForegroundWindow()
    // Compare ADDRESSES, not the pointer objects: koffi hands back a fresh external
    // wrapper each call, so `===` on them is always false and the poll would never
    // succeed — a bug that looks exactly like "focus never came back".
    if (now && w.koffi.address(now) === target) return true
    await new Promise((r) => setTimeout(r, POLL_MS))
  }
  return false
}
