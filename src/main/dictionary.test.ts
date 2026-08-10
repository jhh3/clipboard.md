import { describe, it, expect } from 'vitest'
import { parseDictionary, applyDictionary, correctTranscript } from './dictionary'

describe('parseDictionary', () => {
  it('reads substitutions and bare canonical terms', () => {
    expect(parseDictionary('clipboard dot md => clipboard.md\nParakeet')).toEqual([
      { from: 'clipboard dot md', to: 'clipboard.md' },
      { from: 'Parakeet', to: 'Parakeet' }
    ])
  })

  it('skips blanks, comments and rules with no left-hand side', () => {
    expect(parseDictionary('\n# a note\n  \n=> orphan\n')).toEqual([])
  })

  it('treats an empty right-hand side as a deletion', () => {
    // Removing a verbal tic is a legitimate use: "um =>" should delete it.
    expect(parseDictionary('um =>')).toEqual([{ from: 'um', to: '' }])
  })
})

describe('applyDictionary', () => {
  const rules = parseDictionary('clipboard dot md => clipboard.md\nParakeet\nsherpa => sherpa-onnx')

  it('substitutes case-insensitively but writes the canonical form', () => {
    expect(applyDictionary('I opened Clipboard Dot MD today', rules)).toBe(
      'I opened clipboard.md today'
    )
    expect(applyDictionary('the parakeet model', rules)).toBe('the Parakeet model')
  })

  it('matches across a whitespace run the recogniser inserted', () => {
    expect(applyDictionary('open clipboard  dot\nmd now', rules)).toBe('open clipboard.md now')
  })

  it('respects word boundaries so it cannot corrupt longer words', () => {
    // "sherpas" must not become "sherpa-onnxs".
    expect(applyDictionary('two sherpas walked', rules)).toBe('two sherpas walked')
  })

  it('still matches rules whose edges are punctuation', () => {
    // \b next to '.' never matches, which would silently drop this substitution.
    const punct = parseDictionary('dot md => .md')
    expect(applyDictionary('a file ending dot md', punct)).toBe('a file ending .md')
  })

  it('prefers the longest rule when one contains another', () => {
    const nested = parseDictionary('open ai => OpenAI\nopen ai codex => OpenAI Codex')
    expect(applyDictionary('use open ai codex here', nested)).toBe('use OpenAI Codex here')
  })

  it('leaves text alone when no rule matches', () => {
    expect(applyDictionary('nothing to see', rules)).toBe('nothing to see')
  })
})

describe('correctTranscript', () => {
  it('is a no-op without a dictionary', () => {
    expect(correctTranscript('hello there', undefined)).toBe('hello there')
    expect(correctTranscript('hello there', '   ')).toBe('hello there')
  })
})
