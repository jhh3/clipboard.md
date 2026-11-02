import { LINUX } from './platform'
import { activeWmClass } from './xconn'

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

/**
 * WM_CLASS of the focused window, lowercased, or null when no X11 window has focus.
 *
 * One round trip on the shared X connection (xconn.ts); this used to be two `xprop`
 * spawns plus a 60ms retry for the 0x0 that _NET_ACTIVE_WINDOW reads while focus is
 * in flight. The paste path now waits for focus to land before asking (see
 * paste.ts), so the retry has nothing left to cover.
 */
export async function focusedWmClass(): Promise<string | null> {
  if (!LINUX) return null
  return (await activeWmClass())?.toLowerCase() ?? null
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
  if (!LINUX) return
  void focusedWmClass().then((c) => {
    dictationTarget = c
  })
}

export function getDictationTarget(): string | null {
  return dictationTarget
}
