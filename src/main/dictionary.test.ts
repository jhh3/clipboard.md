import { describe, it, expect } from 'vitest'
import {
  parseDictionary,
  applyDictionary,
  applyStyle,
  correctTranscript,
  stripFillers,
  styleForApp
} from './dictionary'

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

describe('stripFillers', () => {
  it('removes hesitation sounds and their lengthened forms', () => {
    expect(stripFillers('um I think uhh maybe ummm yes').replace(/\s+/g, ' ').trim()).toBe(
      'I think maybe yes'
    )
    expect(stripFillers('hmm erm err ahh ahem ok').replace(/\s+/g, ' ').trim()).toBe('ok')
  })

  it('leaves words that merely contain a filler', () => {
    expect(stripFillers('the umbrella hummed')).toBe('the umbrella hummed')
  })

  it('keeps units and affirmations that a looser list would eat', () => {
    // 'mm' is a unit; 'mhm' and 'uh-huh' mean yes — deleting them inverts meaning.
    expect(stripFillers('cut it 5 mm wide')).toBe('cut it 5 mm wide')
    expect(stripFillers('mhm, exactly')).toBe('mhm, exactly')
    // Bare 'ah' is plausibly deliberate, so it survives.
    expect(stripFillers('ah, right')).toBe('ah, right')
  })
})

describe('applyStyle casual', () => {
  const casual = (t: string): string => applyStyle(t, 'casual')

  it('lowercases essentially everything, not just the first word', () => {
    expect(casual("That's fine. It's already merged. Maybe we wait.")).toBe(
      "that's fine. it's already merged. maybe we wait."
    )
    expect(casual('Can you check the build? Then we should ship it.')).toBe(
      'can you check the build? then we should ship it.'
    )
    expect(casual('Ship it on Wednesday and tell the team in Slack')).toBe(
      'ship it on wednesday and tell the team in slack'
    )
  })

  it('keeps "I" and its contractions', () => {
    expect(casual('I think so')).toBe('I think so')
    expect(casual("I'm on it and I'll check")).toBe("I'm on it and I'll check")
  })

  it('keeps acronyms', () => {
    expect(casual('The API is down and the PR failed CI')).toBe(
      'the API is down and the PR failed CI'
    )
  })

  it('keeps names with an internal capital, which are always deliberate', () => {
    expect(casual('Check OpenAI and GitHub on macOS')).toBe('check OpenAI and GitHub on macOS')
  })

  it('drops a lone trailing full stop but keeps ? and !', () => {
    expect(casual('We should ship it.')).toBe('we should ship it')
    expect(casual('Are you sure?')).toBe('are you sure?')
    expect(casual('The build is green. We can ship.')).toBe('the build is green. we can ship.')
  })

  it('is a no-op for as-spoken', () => {
    expect(applyStyle('Can you check that?', 'as-spoken')).toBe('Can you check that?')
  })
})

describe('correctTranscript', () => {
  it('cleans up by default, with no configuration at all', () => {
    expect(correctTranscript('um, so I think we should ship it')).toBe(
      'So I think we should ship it'
    )
  })

  it('repairs the punctuation that deletion leaves behind', () => {
    // Without repair this is "So, , I think" — the reason a naive wordlist is unsafe.
    expect(correctTranscript('So, um, I think so')).toBe('So, I think so')
    expect(correctTranscript('it is, uh, fine')).toBe('It is, fine')
  })

  it('capitalises the first word when the filler was the sentence opener', () => {
    expect(correctTranscript('uh hello there')).toBe('Hello there')
  })

  it('does not recapitalise after abbreviations', () => {
    expect(correctTranscript('compare vs. the other one')).toBe('Compare vs. the other one')
  })

  it('can be turned off', () => {
    expect(correctTranscript('um, so I think', { cleanup: false })).toBe('um, so I think')
  })

  it('applies cleanup and the dictionary together', () => {
    expect(
      correctTranscript('um, open clipboard dot md', {
        dictionary: 'clipboard dot md => clipboard.md'
      })
    ).toBe('Open clipboard.md')
  })

  it('leaves clean text alone', () => {
    expect(correctTranscript('The quick brown fox.')).toBe('The quick brown fox.')
  })
})

describe('styleForApp', () => {
  const profiles = 'slack => casual\nwezterm => as-spoken\n# comment\nbroken line'

  it('matches on a fragment of the window class', () => {
    expect(styleForApp(profiles, 'slack')).toBe('casual')
    expect(styleForApp(profiles, 'org.wezfurlong.wezterm')).toBe('as-spoken')
  })

  it('returns null when nothing is configured or nothing matches', () => {
    expect(styleForApp(undefined, 'slack')).toBeNull()
    expect(styleForApp(profiles, 'google-chrome')).toBeNull()
    expect(styleForApp(profiles, null)).toBeNull()
  })

  it('ignores comments, malformed lines and unknown styles', () => {
    expect(styleForApp('chrome => shouty', 'google-chrome')).toBeNull()
  })
})
