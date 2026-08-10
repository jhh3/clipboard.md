import { execFile } from 'child_process'

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

/** WM_CLASS of the focused window, lowercased, or null when it cannot be determined. */
export async function focusedWmClass(): Promise<string | null> {
  try {
    const active = await xprop(['-root', '_NET_ACTIVE_WINDOW'])
    const id = active.match(/0x[0-9a-f]+/i)?.[0]
    if (!id) return null
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
