import { describe, expect, it } from 'vitest'
import { ftsQuery } from './fts'

describe('ftsQuery', () => {
  it('quotes tokens and prefix-matches the last', () => {
    expect(ftsQuery('hello world')).toBe('"hello" "world"*')
  })

  it('returns empty for whitespace-only input', () => {
    expect(ftsQuery('   ')).toBe('')
  })

  it('escapes embedded quotes so user input cannot break the MATCH syntax', () => {
    expect(ftsQuery('say "hi"')).toBe('"say" """hi"""*')
  })

  it('treats FTS operators as literals, not syntax', () => {
    // Unquoted, these would be column filters / boolean operators.
    expect(ftsQuery('NOT title:x')).toBe('"NOT" "title:x"*')
  })

  it('drops the prefix star on a one-character last token', () => {
    expect(ftsQuery('a')).toBe('"a"')
    expect(ftsQuery('plan b')).toBe('"plan" "b"')
    expect(ftsQuery('ab')).toBe('"ab"*')
  })
})
