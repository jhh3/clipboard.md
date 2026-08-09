import { describe, expect, it } from 'vitest'
import {
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

  it('refuses a bare key, which would swallow it system-wide', () => {
    expect(parseChord('Space')).toBeNull()
    expect(parseChord('F5')).toBeNull()
  })

  it('falls back to the default rather than leaving dictation unbound', () => {
    expect(formatChord(parseChordOrDefault('nonsense'))).toBe(DEFAULT_DICTATE_CHORD)
    expect(formatChord(parseChordOrDefault(undefined))).toBe(DEFAULT_DICTATE_CHORD)
    expect(formatChord(parseChordOrDefault('Super+F9'))).toBe('Super+F9')
  })
})
