import { describe, expect, it } from 'vitest'
import {
  chordWarning,
  DEFAULT_DICTATE_CHORD,
  formatChord,
  parseChord,
  parseChordOrDefault,
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
