import { execFile } from 'child_process'
import { LINUX } from './platform'

/**
 * Which application is about to receive our injected keystroke.
 *
 * This exists because "paste" is not one keystroke. Ctrl+V is paste in GUI toolkits,
 * but in a terminal it is not: terminals reserve Ctrl+V for the literal-next escape
 * and use Ctrl+Shift+V to paste. Injecting the wrong one is silent — the keystroke is
 * delivered, the app just does something else with it. Claude Code in a terminal binds
 * plain Ctrl+V to "paste image from clipboard", so a dictated transcript produced a
 * "no image in clipboard" warning and no text, while our log said `injected via portal`.
 *
 * GNOME's own answer to this question, org.gnome.Shell.Introspect.GetWindows, is
 * refused to unprivileged callers (`AccessDenied: GetWindows is not allowed`), so the
 * only route left is Xwayland's _NET_ACTIVE_WINDOW.
 *
 * LIMIT, and it is a real one: that property only tracks X11/Xwayland windows. When a
 * natively-Wayland window has focus the value is stale, and we would be reading the
 * last X11 window instead. Callers must therefore treat a terminal match as a hint that
 * only ever ADDS Shift — never as grounds to withhold a paste.
 */

const XPROP_TIMEOUT_MS = 400

function xprop(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('xprop', args, { timeout: XPROP_TIMEOUT_MS }, (err, stdout) => {
      if (err) reject(err)
      else resolve(stdout)
    })
  })
}

/**
 * WM_CLASS of the focused window, with one short retry.
 *
 * We ask immediately after hiding our own window, which is exactly when focus is in
 * flight and _NET_ACTIVE_WINDOW can read 0x0. xprop itself costs ~8ms, so a single
 * retry is far cheaper than the failure it prevents.
 */
export async function focusedWmClass(): Promise<string | null> {
  const first = await readWmClass()
  if (first) return first
  await new Promise((r) => setTimeout(r, RETRY_DELAY_MS))
  return readWmClass()
}

const RETRY_DELAY_MS = 60

async function readWmClass(): Promise<string | null> {
  try {
    const active = await xprop(['-root', '_NET_ACTIVE_WINDOW'])
    const id = active.match(/0x[0-9a-f]+/i)?.[0]
    // 0x0 means "no X11 window is active" — mutter reports it while focus is moving,
    // including the moment just after we hide our own window. It matched the regex,
    // so we passed it to xprop, which rejects it, and the caller fell back to a plain
    // Ctrl+V: in a terminal that pastes nothing at all.
    if (!id || /^0x0+$/i.test(id)) return null
    // WM_CLASS(STRING) = "instance", "Class" — the second is the one apps are known by,
    // but single-valued replies happen, so fall back to the first.
    const cls = await xprop(['-id', id, 'WM_CLASS'])
    const pair = cls.match(/"([^"]*)"\s*,\s*"([^"]*)"/)
    if (pair) return (pair[2] || pair[1]).toLowerCase()
    const single = cls.match(/"([^"]*)"/)
    return single ? single[1].toLowerCase() : null
  } catch {
    // No xprop, no X server, or no focused X11 window. Callers fall back to Ctrl+V.
    return null
  }
}

/**
 * Terminals, by WM_CLASS. Substring matching on purpose: the same emulator ships under
 * several ids across distros and versions (`gnome-terminal-server`, `xfce4-terminal`,
 * `io.elementary.terminal` all contain "terminal"), and a false negative here just
 * means the current, already-wrong behaviour.
 */
const TERMINAL_CLASS_PARTS = [
  'terminal', // gnome-terminal-server, xfce4-terminal, io.elementary.terminal, terminator
  'wezterm',
  'konsole',
  'xterm', // also matches uxterm
  'alacritty',
  'kitty',
  'ghostty',
  'tilix',
  'guake',
  'urxvt',
  'rxvt',
  'foot',
  'warp',
  'contour',
  'wave'
]

/** True when the focused window is a terminal emulator, which pastes on Ctrl+Shift+V. */
export function isTerminalClass(wmClass: string | null): boolean {
  if (!wmClass) return false
  return TERMINAL_CLASS_PARTS.some((part) => wmClass.includes(part))
}

/**
 * The app that was focused when dictation STARTED.
 *
 * Captured at the start of a recording rather than when its transcript arrives: by
 * then our own HUD has been shown and, on Wayland, the focused window may well be
 * ours. This is what per-application style profiles are keyed on.
 */
let dictationTarget: string | null = null

export function noteDictationTarget(): void {
  dictationTarget = null
  // xprop exists only under X11/Xwayland. On macOS this spawned a process that could
  // never succeed, once per dictation, purely to throw it away.
  if (!LINUX) return
  void focusedWmClass().then((c) => {
    dictationTarget = c
  })
}

export function getDictationTarget(): string | null {
  return dictationTarget
}
