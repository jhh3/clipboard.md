import { describe, it, expect } from 'vitest'
import { normalizeNumbers } from './numbers'

describe('normalizeNumbers', () => {
  it('converts ten and above', () => {
    expect(normalizeNumbers('another twenty tech debt items')).toBe('another 20 tech debt items')
    expect(normalizeNumbers('about fifteen minutes')).toBe('about 15 minutes')
    expect(normalizeNumbers('twenty five items')).toBe('25 items')
    expect(normalizeNumbers('a hundred and twenty three')).toBe('a 123')
    expect(normalizeNumbers('two thousand items')).toBe('2000 items')
  })

  it('leaves small numbers as words — the common case in real transcripts', () => {
    // Measured against 76 real dictations: these are the shapes that actually occur.
    expect(normalizeNumbers('a one click install')).toBe('a one click install')
    expect(normalizeNumbers('one of my agents came up with')).toBe('one of my agents came up with')
    expect(normalizeNumbers('split up into two dictations')).toBe('split up into two dictations')
    expect(normalizeNumbers('there were two processes')).toBe('there were two processes')
  })

  it('uses numerals for small values when a unit is attached', () => {
    expect(normalizeNumbers('wait five minutes')).toBe('wait 5 minutes')
    expect(normalizeNumbers('five percent slower')).toBe('5 percent slower')
    expect(normalizeNumbers('two gb of memory')).toBe('2 gb of memory')
  })

  it('does not run words across punctuation', () => {
    expect(normalizeNumbers('twenty, thirty items')).toBe('20, 30 items')
  })

  it('leaves text with no numbers untouched', () => {
    expect(normalizeNumbers('nothing numeric here')).toBe('nothing numeric here')
  })

  it('is case-insensitive and preserves surrounding text', () => {
    expect(normalizeNumbers('Bump it to Thirty items please')).toBe('Bump it to 30 items please')
  })
})
