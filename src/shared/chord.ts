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
 * Main key name → its Linux evdev keycode and its GNOME keysym token.
 *
 * Both representations live in one table so a key can never be added to the trigger
 * and forgotten in the observer. Anything absent is rejected at parse time rather
 * than silently producing a chord evdev can never match.
 *
 * The unglamorous half of this table — F13–F24, the numpad, Insert/Home/Menu — is the
 * useful half. Programmable keypads and macro pads are normally configured to emit
 * exactly those, because nothing else on the machine uses them, which makes them the
 * best possible push-to-talk keys: a single button you can hold, with no chord and
 * nothing else to collide with.
 */
interface KeyDef {
  /** input-event-codes.h */
  code: number
  /** What GNOME wants in a binding string. */
  gnome: string
  /** True for keys you type with, where binding them bare would be destructive. */
  typing?: boolean
}

const KEYS: Record<string, KeyDef> = {
  Space: { code: 57, gnome: 'space', typing: true },
  // Letters and digits
  ...Object.fromEntries(
    Object.entries({
      A: 30, B: 48, C: 46, D: 32, E: 18, F: 33, G: 34, H: 35, I: 23,
      J: 36, K: 37, L: 38, M: 50, N: 49, O: 24, P: 25, Q: 16, R: 19,
      S: 31, T: 20, U: 22, V: 47, W: 17, X: 45, Y: 21, Z: 44,
      '1': 2, '2': 3, '3': 4, '4': 5, '5': 6, '6': 7, '7': 8, '8': 9, '9': 10, '0': 11
    }).map(([k, code]) => [k, { code, gnome: k.toLowerCase(), typing: true } as KeyDef])
  ),
  // Function keys. F13+ are what most macro pads emit.
  ...Object.fromEntries(
    (
      [
        ['F1', 59], ['F2', 60], ['F3', 61], ['F4', 62], ['F5', 63], ['F6', 64],
        ['F7', 65], ['F8', 66], ['F9', 67], ['F10', 68], ['F11', 87], ['F12', 88],
        ['F13', 183], ['F14', 184], ['F15', 185], ['F16', 186], ['F17', 187], ['F18', 188],
        ['F19', 189], ['F20', 190], ['F21', 191], ['F22', 192], ['F23', 193], ['F24', 194]
      ] as Array<[string, number]>
    ).map(([k, code]) => [k, { code, gnome: k } as KeyDef])
  ),
  // Numpad. GNOME spells these KP_*; the browser reports them as Numpad*.
  Numpad0: { code: 82, gnome: 'KP_0' },
  Numpad1: { code: 79, gnome: 'KP_1' },
  Numpad2: { code: 80, gnome: 'KP_2' },
  Numpad3: { code: 81, gnome: 'KP_3' },
  Numpad4: { code: 75, gnome: 'KP_4' },
  Numpad5: { code: 76, gnome: 'KP_5' },
  Numpad6: { code: 77, gnome: 'KP_6' },
  Numpad7: { code: 71, gnome: 'KP_7' },
  Numpad8: { code: 72, gnome: 'KP_8' },
  Numpad9: { code: 73, gnome: 'KP_9' },
  NumpadAdd: { code: 78, gnome: 'KP_Add' },
  NumpadSubtract: { code: 74, gnome: 'KP_Subtract' },
  NumpadMultiply: { code: 55, gnome: 'KP_Multiply' },
  NumpadDivide: { code: 98, gnome: 'KP_Divide' },
  NumpadDecimal: { code: 83, gnome: 'KP_Decimal' },
  NumpadEnter: { code: 96, gnome: 'KP_Enter' },
  // Navigation and the odds and ends a macro pad may send.
  Insert: { code: 110, gnome: 'Insert' },
  Delete: { code: 111, gnome: 'Delete' },
  Home: { code: 102, gnome: 'Home' },
  End: { code: 107, gnome: 'End' },
  PageUp: { code: 104, gnome: 'Page_Up' },
  PageDown: { code: 109, gnome: 'Page_Down' },
  Pause: { code: 119, gnome: 'Pause' },
  ScrollLock: { code: 70, gnome: 'Scroll_Lock' },
  Menu: { code: 127, gnome: 'Menu' }
}

/** Modifier keycodes, left and right variants — either side satisfies the chord. */
export const MOD_CODES = {
  ctrl: [29, 97],
  alt: [56, 100],
  shift: [42, 54],
  meta: [125, 126]
} as const

/** The GNOME binding token for a main key. */
function gnomeKeyToken(key: string): string {
  return KEYS[key]?.gnome ?? key.toLowerCase()
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
  // A bare key IS allowed. It is the right answer for a programmable keypad, where
  // the whole point is one dedicated button with no chord. Whether a particular bare
  // key is a GOOD idea is a separate question — see chordWarning, which the UI
  // surfaces instead of refusing outright.
  return chord
}

/** Normalise a key name to the casing used in KEY_CODES, or null if unsupported. */
export function canonicalKey(raw: string): string | null {
  const t = raw.trim()
  if (!t) return null
  if (KEYS[t]) return t // already canonical (Numpad0, PageUp, F13…)
  const upper = t.toUpperCase()
  if (upper === 'SPACE' || t === ' ') return 'Space'
  if (KEYS[upper]) return upper
  // Case-insensitive fallback, so "numpad0" and "pageup" work when typed by hand.
  const match = Object.keys(KEYS).find((k) => k.toUpperCase() === upper)
  return match ?? null
}

/**
 * Why a chord might be a bad idea, or null when it is fine.
 *
 * A warning rather than a refusal: binding a bare typing key really does swallow it
 * everywhere, but that is the user's call to make — and for a dedicated keypad button
 * there is nothing to warn about at all.
 */
export function chordWarning(c: Chord): string | null {
  const bare = !c.ctrl && !c.alt && !c.shift && !c.meta
  if (!bare) return null
  if (KEYS[c.key]?.typing) {
    return `${c.key} on its own will be captured everywhere, including while you type. Add a modifier, or pick a keypad or F13+ key.`
  }
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
  const key = KEYS[c.key]?.code
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
