import { describe, expect, it } from 'vitest'
import {
  chordWarning,
  DEFAULT_DICTATE_CHORD,
  formatChord,
  parseChord,
  parseChordOrDefault,
  effectiveDictateChord,
  toAccelerator,
  toEvdevChord,
  toGnomeBinding
} from './chord'

describe('chord', () => {
  it('round-trips the shipped default', () => {
    const c = parseChord(DEFAULT_DICTATE_CHORD)!
    expect(c).toEqual({ ctrl: true, alt: true, shift: false, meta: false, key: 'Space' })
    expect(formatChord(c)).toBe(DEFAULT_DICTATE_CHORD)
  })

  /**
   * The whole point of the module: both representations come from one chord, so the
   * GNOME trigger and the evdev observer can never drift apart the way the two
   * hardcoded copies did.
   */
  it('derives the GNOME binding and the evdev codes from the same chord', () => {
    const c = parseChord('Ctrl+Alt+Space')!
    expect(toGnomeBinding(c)).toBe('<Control><Alt>space')
    const e = toEvdevChord(c)!
    expect(e.key).toBe(57)
    expect(e.modifierGroups).toEqual([
      [29, 97],
      [56, 100]
    ])
    // Both left and right modifiers are watched, plus the main key.
    expect([...e.watched].sort((a, b) => a - b)).toEqual([29, 56, 57, 97, 100])
  })

  it('accepts letters, digits and function keys', () => {
    expect(toGnomeBinding(parseChord('Ctrl+Shift+D')!)).toBe('<Control><Shift>d')
    expect(toEvdevChord(parseChord('Super+F5')!)!.key).toBe(63)
    expect(toEvdevChord(parseChord('Alt+7')!)!.key).toBe(8)
  })

  it('is case- and alias-insensitive on input', () => {
    expect(formatChord(parseChord('control+option+space')!)).toBe('Ctrl+Alt+Space')
    expect(formatChord(parseChord('CMD+q')!)).toBe('Super+Q')
  })

  /**
   * A chord we cannot express in BOTH targets must be rejected outright. Accepting
   * one that evdev can never match would look bound and never fire — the exact
   * silent-degradation failure this module exists to prevent.
   */
  it('rejects chords it cannot faithfully express', () => {
    expect(parseChord('Ctrl+Alt+£')).toBeNull() // no evdev code for it
    expect(parseChord('Ctrl+Alt+Space+V')).toBeNull() // two main keys
    expect(parseChord('Ctrl+Alt')).toBeNull() // modifiers only
    expect(parseChord('')).toBeNull()
  })

  /**
   * A programmable keypad's whole appeal is one dedicated button, so a bare key has
   * to be bindable. These keys are also the ones a macro pad actually emits.
   */
  it('accepts a single key, for a macro pad', () => {
    for (const k of ['F13', 'F24', 'Numpad0', 'NumpadEnter', 'Insert', 'Pause', 'Menu']) {
      const c = parseChord(k)
      expect(c, k).not.toBeNull()
      expect(toEvdevChord(c!)!.modifierGroups).toEqual([])
      expect(chordWarning(c!), k).toBeNull()
    }
    expect(toEvdevChord(parseChord('F13')!)!.key).toBe(183)
    expect(toGnomeBinding(parseChord('Numpad0')!)).toBe('KP_0')
    expect(toGnomeBinding(parseChord('PageUp')!)).toBe('Page_Up')
  })

  /** Bare typing keys are allowed but flagged — binding them really is destructive. */
  it('warns about a bare typing key without refusing it', () => {
    expect(parseChord('Space')).not.toBeNull()
    expect(chordWarning(parseChord('Space')!)).toMatch(/everywhere/)
    expect(chordWarning(parseChord('A')!)).toMatch(/everywhere/)
    // With a modifier there is nothing to warn about.
    expect(chordWarning(parseChord('Ctrl+Alt+Space')!)).toBeNull()
  })

  it('matches a bare key on the main key alone', () => {
    const e = toEvdevChord(parseChord('F13')!)!
    expect([...e.watched]).toEqual([183])
  })

  it('falls back to the default rather than leaving dictation unbound', () => {
    expect(formatChord(parseChordOrDefault('nonsense'))).toBe(DEFAULT_DICTATE_CHORD)
    expect(formatChord(parseChordOrDefault(undefined))).toBe(DEFAULT_DICTATE_CHORD)
    expect(formatChord(parseChordOrDefault('Super+F9'))).toBe('Super+F9')
  })
})

describe('toAccelerator', () => {
  /**
   * Every key in the table, with an explicit expectation — including the four that
   * must be null. Electron's accelerator names for the numpad are not guessable
   * (`num0`, not `Numpad0` or `KP_0`), and writing the browser name registers
   * nothing at all while `register()` cheerfully returns.
   */
  const expected: Record<string, string | null> = {
    Space: 'Space',
    A: 'A',
    Z: 'Z',
    '0': '0',
    '9': '9',
    F1: 'F1',
    F13: 'F13',
    F24: 'F24',
    Numpad0: 'num0',
    Numpad9: 'num9',
    NumpadAdd: 'numadd',
    NumpadSubtract: 'numsub',
    NumpadMultiply: 'nummult',
    NumpadDivide: 'numdiv',
    NumpadDecimal: 'numdec',
    Insert: 'Insert',
    Delete: 'Delete',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown',
    // Electron's grammar has no token for these. A guess would register nothing.
    NumpadEnter: null,
    Pause: null,
    ScrollLock: null,
    Menu: null
  }

  for (const [key, accel] of Object.entries(expected)) {
    it(`${key} -> ${accel ?? 'null'}`, () => {
      const chord = parseChord(key)
      expect(chord).not.toBeNull()
      expect(toAccelerator(chord!)).toBe(accel)
    })
  }

  it('spells the modifiers the way Electron does', () => {
    expect(toAccelerator(parseChord('Ctrl+Shift+V')!)).toBe('Control+Shift+V')
    expect(toAccelerator(parseChord('Ctrl+Alt+Shift+Super+A')!)).toBe('Control+Alt+Shift+Super+A')
    expect(toAccelerator(parseChord('Super+Space')!)).toBe('Super+Space')
  })

  it('leaves the other two output forms alone for every key', () => {
    // The whole point of shared/chord.ts is that the representations cannot drift.
    // Adding a third must not perturb the two that Linux depends on.
    for (const key of Object.keys(expected)) {
      const chord = parseChord(key)!
      expect(toGnomeBinding(chord), key).toBe(GNOME_BEFORE[key])
      expect(toEvdevChord(chord)?.key, key).toBe(EVDEV_BEFORE[key])
    }
  })
})

/** The GNOME and evdev outputs as they shipped, pinned so a later edit cannot move them. */
const GNOME_BEFORE: Record<string, string> = {
  Space: 'space', A: 'a', Z: 'z', '0': '0', '9': '9',
  F1: 'F1', F13: 'F13', F24: 'F24',
  Numpad0: 'KP_0', Numpad9: 'KP_9', NumpadAdd: 'KP_Add', NumpadSubtract: 'KP_Subtract',
  NumpadMultiply: 'KP_Multiply', NumpadDivide: 'KP_Divide', NumpadDecimal: 'KP_Decimal',
  NumpadEnter: 'KP_Enter',
  Insert: 'Insert', Delete: 'Delete', Home: 'Home', End: 'End',
  PageUp: 'Page_Up', PageDown: 'Page_Down',
  Pause: 'Pause', ScrollLock: 'Scroll_Lock', Menu: 'Menu'
}

const EVDEV_BEFORE: Record<string, number> = {
  Space: 57, A: 30, Z: 44, '0': 11, '9': 10,
  F1: 59, F13: 183, F24: 194,
  Numpad0: 82, Numpad9: 73, NumpadAdd: 78, NumpadSubtract: 74,
  NumpadMultiply: 55, NumpadDivide: 98, NumpadDecimal: 83, NumpadEnter: 96,
  Insert: 110, Delete: 111, Home: 102, End: 107,
  PageUp: 104, PageDown: 109,
  Pause: 119, ScrollLock: 70, Menu: 127
}

describe('effectiveDictateChord', () => {
  it('leaves linux and darwin on the shipped default', () => {
    expect(effectiveDictateChord(undefined, 'linux')).toBe('Ctrl+Alt+Space')
    expect(effectiveDictateChord('Ctrl+Alt+Space', 'darwin')).toBe('Ctrl+Alt+Space')
  })

  it('substitutes Ctrl+Shift on Windows, where Ctrl+Alt is AltGr', () => {
    // Registering Ctrl+Alt+Space system-wide on a non-US layout takes AltGr+Space
    // away from the user everywhere on the machine, for as long as the app runs.
    expect(effectiveDictateChord(undefined, 'win32')).toBe('Ctrl+Shift+Space')
    expect(effectiveDictateChord('Ctrl+Alt+Space', 'win32')).toBe('Ctrl+Shift+Space')
  })

  it('never overrides a chord the user chose', () => {
    // Including one that collides with AltGr: that is their call, and silently
    // moving it would be worse than the collision.
    expect(effectiveDictateChord('Ctrl+Alt+D', 'win32')).toBe('Ctrl+Alt+D')
    expect(effectiveDictateChord('F13', 'win32')).toBe('F13')
  })

  it('does not write anything back, so a synced profile works on both', () => {
    const stored = 'Ctrl+Alt+Space'
    effectiveDictateChord(stored, 'win32')
    expect(stored).toBe('Ctrl+Alt+Space')
  })
})
