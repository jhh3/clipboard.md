/**
 * User dictionary for dictation, applied to the transcript after recognition.
 *
 * This is deliberately NOT sherpa-onnx contextual biasing. Hotwords would be the
 * "proper" fix — bias the decoder toward your jargon — but they require
 * decodingMethod 'modified_beam_search', and that path is reported to hallucinate or
 * return empty text ~20% of the time on the exact model we ship, NeMo TDT Parakeet
 * (k2-fsa/sherpa-onnx#3267), while greedy_search is solid. Losing a fifth of
 * dictations to get proper nouns right is a bad trade, so the correction happens
 * after decoding instead: deterministic, offline, and unable to affect accuracy of
 * anything it does not match.
 *
 * Rules are one per line:
 *   clipboard dot md => clipboard.md    explicit substitution
 *   Parakeet                            canonical spelling; matches case-insensitively
 *   # comment                           ignored
 */

export interface DictRule {
  /** What the recogniser tends to produce. */
  from: string
  /** What it should have produced. */
  to: string
}

/** Parse the settings blob into rules, skipping blanks, comments and malformed lines. */
export function parseDictionary(text: string | undefined): DictRule[] {
  if (!text) return []
  const rules: DictRule[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const arrow = line.indexOf('=>')
    if (arrow === -1) {
      // A bare term is its own target: it fixes casing and spelling of a word the
      // model already hears correctly ("parakeet" -> "Parakeet").
      rules.push({ from: line, to: line })
      continue
    }
    const from = line.slice(0, arrow).trim()
    const to = line.slice(arrow + 2).trim()
    if (from) rules.push({ from, to })
  }
  return rules
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Apply rules to a transcript.
 *
 * Longest `from` first, so a specific phrase wins over a shorter rule nested inside
 * it. Boundaries are asserted only where the rule's own edges are word characters —
 * `\b` next to punctuation (a rule like "clipboard.md") never matches, which would
 * silently drop exactly the substitutions people write dictionaries for.
 */
export function applyDictionary(text: string, rules: DictRule[]): string {
  let out = text
  for (const rule of [...rules].sort((a, b) => b.from.length - a.from.length)) {
    const body = escapeRegex(rule.from)
    const lead = /^\w/.test(rule.from) ? '\\b' : ''
    const trail = /\w$/.test(rule.from) ? '\\b' : ''
    // Whitespace in a rule matches any run of whitespace: the recogniser may have
    // split "clipboard dot md" across a line break or doubled a space.
    const pattern = body.replace(/\s+/g, '\\s+')
    out = out.replace(new RegExp(`${lead}${pattern}${trail}`, 'gi'), rule.to)
  }
  return out
}

/** Convenience: parse and apply in one call. */
export function correctTranscript(text: string, dictionary: string | undefined): string {
  const rules = parseDictionary(dictionary)
  return rules.length ? applyDictionary(text, rules) : text
}
