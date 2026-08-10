import { describe, it, expect } from 'vitest'
import { singleSubstitution, plausibleWritten, soundsAlike, soundex } from './correctionsMatch'

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
    expect(soundsAlike('cloud', 'Claude')).toBe(true)
    expect(soundsAlike('cuber netes', 'kubernetes')).toBe(true)
    expect(soundsAlike('github', 'GitHub')).toBe(true)
  })

  it('rejects unrelated words', () => {
    expect(soundsAlike('banana', 'helicopter')).toBe(false)
    expect(soundsAlike('cat', 'dog')).toBe(false)
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

describe('soundex', () => {
  it('codes the way the reference algorithm does', () => {
    expect(soundex('Robert')).toBe('R163')
    expect(soundex('Rupert')).toBe('R163')
    expect(soundex('')).toBe('')
  })
})
