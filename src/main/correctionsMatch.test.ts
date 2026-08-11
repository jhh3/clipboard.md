import { describe, it, expect } from 'vitest'
import {
  singleSubstitution,
  plausibleWritten,
  soundsAlike,
  jaroWinkler
} from './correctionsMatch'

describe('singleSubstitution', () => {
  it('isolates a one-word fix, punctuation stripped', () => {
    expect(singleSubstitution('the cloud is down', 'the Claude is down')).toEqual({
      heard: 'cloud',
      written: 'Claude'
    })
    expect(singleSubstitution('I asked cloud.', 'I asked Claude.')).toEqual({
      heard: 'cloud',
      written: 'Claude'
    })
  })

  it('collapses a split word into one token', () => {
    expect(singleSubstitution('deploy to cuber netes', 'deploy to kubernetes')).toEqual({
      heard: 'cuber netes',
      written: 'kubernetes'
    })
  })

  it('returns null for identical text', () => {
    expect(singleSubstitution('same thing', 'same thing')).toBeNull()
  })

  it('returns null for a pure insertion or deletion', () => {
    expect(singleSubstitution('hello world', 'hello there world')).toBeNull()
    expect(singleSubstitution('hello there world', 'hello world')).toBeNull()
  })

  it('returns null for a large rewrite (not one localized fix)', () => {
    expect(singleSubstitution('a b c d e', 'v w x y e')).toBeNull()
  })
})

describe('soundsAlike', () => {
  it('accepts near-homophones and split-word merges', () => {
    expect(soundsAlike('cloud', 'Claude')).toBe(true) // Double Metaphone: both KLT
    expect(soundsAlike('cuber netes', 'kubernetes')).toBe(true) // 1 edit after normalize
    expect(soundsAlike('github', 'GitHub')).toBe(true)
    expect(soundsAlike('knight', 'night')).toBe(true) // silent-letter, metaphone catches it
  })

  it('rejects unrelated words', () => {
    expect(soundsAlike('banana', 'helicopter')).toBe(false)
    expect(soundsAlike('cat', 'dog')).toBe(false)
    expect(soundsAlike('kubernetes', 'deployment')).toBe(false)
  })
})

describe('jaroWinkler', () => {
  it('scores identical, similar, and unrelated strings', () => {
    expect(jaroWinkler('martha', 'martha')).toBe(1)
    expect(jaroWinkler('martha', 'marhta')).toBeGreaterThan(0.9) // classic transposition
    expect(jaroWinkler('abc', 'xyz')).toBe(0)
  })
})

describe('plausibleWritten', () => {
  it('accepts short word-shaped forms', () => {
    expect(plausibleWritten('Kubernetes')).toBe(true)
    expect(plausibleWritten('Next.js')).toBe(true)
  })

  it('rejects stopword-only, overlong, and non-word forms', () => {
    expect(plausibleWritten('the')).toBe(false)
    expect(plausibleWritten('a'.repeat(41))).toBe(false)
    expect(plausibleWritten('user@example.com')).toBe(false) // PII shape, has @
    expect(plausibleWritten('one two three four')).toBe(false) // > 3 tokens
  })
})
