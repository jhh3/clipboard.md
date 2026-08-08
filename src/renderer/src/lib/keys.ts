/**
 * Modifier glyphs for shortcut hints. The keymap itself accepts Ctrl OR Cmd
 * everywhere (see useKeymap callers); these only control what the hints DISPLAY,
 * which should be the key people actually press on each platform.
 */
export const IS_MAC = (window.clipmd?.platform ?? '') === 'darwin'

/** Primary modifier glyph: ⌘ on macOS, ⌃ elsewhere. */
export const MOD = IS_MAC ? '⌘' : '⌃'

/** The global-hotkey modifier pair: ⌘⇧ on macOS, ⌃⌥ on Linux (GNOME bindings). */
export const GLOBAL_MOD = IS_MAC ? '⌘⇧' : '⌃⌥'
