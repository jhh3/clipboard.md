/**
 * Modifier glyphs for shortcut hints. The keymap itself accepts Ctrl OR Cmd
 * everywhere (see useKeymap callers); these only control what the hints DISPLAY,
 * which should be the key people actually press on each platform.
 */
export const IS_MAC = (window.clipmd?.platform ?? '') === 'darwin'

/**
 * Windows. Kept as its own flag rather than `!IS_MAC`, because most of the copy in
 * Settings says "GNOME" — literally, in the shortcut help — and on Windows that is
 * not merely wrong, it names a mechanism the user cannot go and look at.
 */
export const IS_WIN = (window.clipmd?.platform ?? '') === 'win32'

/** Primary modifier glyph: ⌘ on macOS, ⌃ elsewhere. */
export const MOD = IS_MAC ? '⌘' : '⌃'

/** The global-hotkey modifier pair: ⌘⇧ on macOS, ⌃⌥ on Linux (GNOME bindings). */
export const GLOBAL_MOD = IS_MAC ? '⌘⇧' : '⌃⌥'
