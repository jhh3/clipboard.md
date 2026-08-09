/**
 * One definition of a keyboard chord, for the two places Linux needs it in
 * incompatible forms.
 *
 * Push-to-talk needs the same chord expressed twice:
 *  - GNOME wants a binding string, `<Control><Alt>space`, to fire the trigger
 *  - evdev wants raw kernel keycodes, 29/56/57, to observe the hold and release
 *
 * These used to be hardcoded separately in hotkeys.ts and ptt.ts, and the split was
 * a genuine trap: change one and dictation degrades silently rather than breaking.
 * Change only the GNOME binding and evdev still watches the old chord, so the app
 * falls back to toggle behaviour; change only the keycodes and the trigger never
 * fires at all. Both are derived from this module now, so they cannot disagree.
 *
 * macOS does NOT use any of this. Dictation there is the Fn/🌐 key via the helper's
 * event tap, with ⌘⇧D as the toggle fallback — see ptt.ts. Nothing here should ever
 * be applied to darwin.
 */

export interface Chord {
  ctrl: boolean
  alt: boolean
  shift: boolean
  /** Super/Meta — the Windows or Command key. */
  meta: boolean
  /** Canonical main-key name: 'Space', 'A', '1', 'F5'. */
  key: string
}

/**
 * Main key name → Linux evdev keycode (input-event-codes.h).
 *
 * Deliberately limited to keys that make sense to HOLD for push-to-talk. Anything
 * absent is rejected at parse time rather than silently producing a chord evdev can
 * never match.
 */
const KEY_CODES: Record<string, number> = {
  Space: 57,
  A: 30, B: 48, C: 46, D: 32, E: 18, F: 33, G: 34, H: 35, I: 23,
  J: 36, K: 37, L: 38, M: 50, N: 49, O: 24, P: 25, Q: 16, R: 19,
  S: 31, T: 20, U: 22, V: 47, W: 17, X: 45, Y: 21, Z: 44,
  '1': 2, '2': 3, '3': 4, '4': 5, '5': 6, '6': 7, '7': 8, '8': 9, '9': 10, '0': 11,
  F1: 59, F2: 60, F3: 61, F4: 62, F5: 63, F6: 64,
  F7: 65, F8: 66, F9: 67, F10: 68, F11: 87, F12: 88
}

/** Modifier keycodes, left and right variants — either side satisfies the chord. */
export const MOD_CODES = {
  ctrl: [29, 97],
  alt: [56, 100],
  shift: [42, 54],
  meta: [125, 126]
} as const

/** The GNOME binding token for each main key. GNOME lowercases letters and space. */
function gnomeKeyToken(key: string): string {
  if (key === 'Space') return 'space'
  if (/^F\d{1,2}$/.test(key)) return key
  return key.toLowerCase()
}

/**
 * Parse "Ctrl+Alt+Space" into a chord. Returns null for anything we cannot faithfully
 * express in BOTH targets — a chord we can't observe in evdev is worse than a
 * rejected one, because it looks bound and never fires.
 */
export function parseChord(input: string): Chord | null {
  if (!input) return null
  const parts = input.split('+').map((p) => p.trim()).filter(Boolean)
  if (parts.length === 0) return null
  const chord: Chord = { ctrl: false, alt: false, shift: false, meta: false, key: '' }
  for (const raw of parts) {
    const p = raw.toLowerCase()
    if (p === 'ctrl' || p === 'control') chord.ctrl = true
    else if (p === 'alt' || p === 'option') chord.alt = true
    else if (p === 'shift') chord.shift = true
    else if (p === 'super' || p === 'meta' || p === 'cmd' || p === 'command') chord.meta = true
    else {
      if (chord.key) return null // two main keys is not a chord we can match
      const canonical = canonicalKey(raw)
      if (!canonical) return null
      chord.key = canonical
    }
  }
  if (!chord.key) return null
  // A bare key with no modifier would swallow that key system-wide — refuse it.
  if (!chord.ctrl && !chord.alt && !chord.shift && !chord.meta) return null
  return chord
}

/** Normalise a key name to the casing used in KEY_CODES, or null if unsupported. */
export function canonicalKey(raw: string): string | null {
  const t = raw.trim()
  if (!t) return null
  const upper = t.toUpperCase()
  if (upper === 'SPACE' || t === ' ') return 'Space'
  if (/^F\d{1,2}$/.test(upper) && KEY_CODES[upper] !== undefined) return upper
  if (KEY_CODES[upper] !== undefined) return upper
  return null
}

/** "Ctrl+Alt+Space" — the canonical display and storage form. */
export function formatChord(c: Chord): string {
  const parts: string[] = []
  if (c.ctrl) parts.push('Ctrl')
  if (c.alt) parts.push('Alt')
  if (c.shift) parts.push('Shift')
  if (c.meta) parts.push('Super')
  parts.push(c.key)
  return parts.join('+')
}

/** The GNOME custom-keybinding string, e.g. `<Control><Alt>space`. */
export function toGnomeBinding(c: Chord): string {
  let out = ''
  if (c.ctrl) out += '<Control>'
  if (c.alt) out += '<Alt>'
  if (c.shift) out += '<Shift>'
  if (c.meta) out += '<Super>'
  return out + gnomeKeyToken(c.key)
}

export interface EvdevChord {
  /** One group per required modifier; any code within a group satisfies it. */
  modifierGroups: number[][]
  /** Keycode of the main key. */
  key: number
  /** Every code involved, for the "ignore anything else without inspecting it" filter. */
  watched: Set<number>
}

/** The evdev view of the chord: which raw keycodes to watch, grouped by role. */
export function toEvdevChord(c: Chord): EvdevChord | null {
  const key = KEY_CODES[c.key]
  if (key === undefined) return null
  const modifierGroups: number[][] = []
  if (c.ctrl) modifierGroups.push([...MOD_CODES.ctrl])
  if (c.alt) modifierGroups.push([...MOD_CODES.alt])
  if (c.shift) modifierGroups.push([...MOD_CODES.shift])
  if (c.meta) modifierGroups.push([...MOD_CODES.meta])
  const watched = new Set<number>([key])
  for (const g of modifierGroups) for (const code of g) watched.add(code)
  return { modifierGroups, key, watched }
}

/** Chord names we ship as the default, in storage form. */
export const DEFAULT_DICTATE_CHORD = 'Ctrl+Alt+Space'

/**
 * Parse with a fallback to the default, so a corrupt or unsupported stored value can
 * never leave dictation with no chord at all.
 */
export function parseChordOrDefault(input: string | undefined): Chord {
  return parseChord(input ?? '') ?? (parseChord(DEFAULT_DICTATE_CHORD) as Chord)
}
