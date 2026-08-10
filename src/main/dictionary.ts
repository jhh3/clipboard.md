import { normalizeNumbers } from './numbers'

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

/**
 * Hesitation sounds, removed by default.
 *
 * Only unambiguous ones. The tempting additions — "like", "you know", "I mean",
 * "basically", "actually", "right" — are discourse markers that are also ordinary
 * English ("I like this"), and a find-and-replace cannot tell the two apart. Deleting
 * a real word is invisible to the user and unrecoverable, so those belong to a model
 * that can read the sentence, or to the user's own dictionary. Every tool surveyed
 * that strips them does it with an LLM, not a wordlist.
 *
 * Specific exclusions, each for a reason:
 *  - `mm` would eat the unit in "5 mm wide"
 *  - bare `ah` is plausibly deliberate ("ah, right"), so only `ahh`+ counts
 *  - `mhm` and `uh-huh` mean *yes*; removing them inverts the sentence
 */
const FILLER_RE = /\b(?:u[mh]+|erm|er+|hm+|ahh+|ahem)\b/gi

/**
 * Repair what deletion leaves behind.
 *
 * Parakeet emits punctuation, so removing a word from the middle of a clause leaves
 * orphaned commas and doubled spaces: "So, um, I think" becomes "So, , I think"
 * without this. Only the first character is re-capitalised — doing it after every
 * sentence end would also rewrite "vs. the" into "vs. The".
 */
function tidy(text: string): string {
  const out = text
    .replace(/[ \t]+/g, ' ')
    // Orphaned separators left where a filler used to be.
    .replace(/([,;:])(\s*[,;:])+/g, '$1')
    .replace(/\s+([,.;:!?])/g, '$1')
    // A clause that now starts with its own separator: ", I think" -> "I think".
    .replace(/(^|[.!?]\s)\s*[,;:]\s*/g, '$1')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .trim()
  return out.charAt(0).toUpperCase() + out.slice(1)
}

/** Strip hesitation sounds. Punctuation and spacing repair happens in tidy(). */
export function stripFillers(text: string): string {
  return text.replace(FILLER_RE, '')
}

/**
 * Output style. Only styles that can be produced deterministically live here.
 *
 * 'casual' is real formatting, not a rewrite: it lowercases sentence openers and
 * drops a lone trailing full stop, which is how people actually type in chat. A
 * 'formal'/'professional' style is deliberately absent — genuine formality means
 * rewording, which needs a model, and faking it with regex would produce text that
 * is neither the user's words nor good prose.
 */
export type TranscriptStyle = 'as-spoken' | 'casual'

/**
 * Words that keep their capital even in casual style.
 *
 * Casual means "typed in a chat window", which in practice means almost nothing is
 * capitalised. So this is a blocklist of the few things that would look broken or
 * change meaning in lower case, and everything else is lowered:
 *
 *  - "I" and its contractions, which are wrong in lower case
 *  - acronyms (API, PR, CPU) — "api is down" reads as a typo
 *  - words with a capital after the first letter (OpenAI, GitHub, macOS, iPhone).
 *    An internal capital is always deliberate, so it is a reliable signal for a
 *    brand or identifier, and it survives while "Slack" and "Wednesday" do not.
 *
 * An earlier version used an ALLOWLIST of common sentence openers instead. It was
 * wrong twice over: the list can never be complete (it missed "Then", "Now",
 * "Probably"), and contractions never matched at all because the captured token
 * includes the apostrophe, so "That's" was looked up whole. The result was a casual
 * mode that appeared to lowercase only the first word of the transcript.
 */
function keepsCapital(word: string): boolean {
  if (word === 'I' || word.startsWith("I'")) return true
  const letters = word.replace(/[^A-Za-z]/g, '')
  if (letters.length > 1 && letters === letters.toUpperCase()) return true // acronym
  return /[A-Z]/.test(word.slice(1)) // internal capital: OpenAI, macOS, GitHub
}

export function applyStyle(text: string, style: TranscriptStyle): string {
  if (style !== 'casual' || !text) return text
  const lowered = text.replace(/\b[A-Za-z][A-Za-z']*/g, (word) =>
    keepsCapital(word) ? word : word.charAt(0).toLowerCase() + word.slice(1)
  )
  // One sentence, ending in a full stop: chat messages don't carry one. '?' and '!'
  // are meaningful, and multi-sentence text still wants its punctuation.
  const sentences = lowered.match(/[.!?](\s|$)/g)?.length ?? 0
  return sentences === 1 && lowered.endsWith('.') ? lowered.slice(0, -1) : lowered
}

export interface CorrectionOptions {
  dictionary?: string
  /** Remove hesitation sounds and repair the punctuation left behind. */
  cleanup?: boolean
  /** Output formatting. Defaults to 'as-spoken'. */
  style?: TranscriptStyle
  /** Spoken numbers to numerals, per the ten-and-up convention. */
  numbers?: boolean
}

/**
 * Per-application overrides, one per line: `wm-class-fragment => style`.
 *
 * Empty by default — an unconfigured install behaves identically everywhere. This is
 * the deterministic half of what VoiceInk calls Power Mode, and it is only possible
 * because the paste path already resolves the destination's WM_CLASS.
 */
export function styleForApp(
  profiles: string | undefined,
  wmClass: string | null
): TranscriptStyle | null {
  if (!profiles || !wmClass) return null
  for (const raw of profiles.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const arrow = line.indexOf('=>')
    if (arrow === -1) continue
    const match = line.slice(0, arrow).trim().toLowerCase()
    const style = line.slice(arrow + 2).trim()
    if (!match || !wmClass.includes(match)) continue
    if (style === 'casual' || style === 'as-spoken') return style
  }
  return null
}

/** The full post-recognition pass: fillers, then user rules, then repair. */
export function correctTranscript(text: string, opts: CorrectionOptions = {}): string {
  const rules = parseDictionary(opts.dictionary)
  // Default ON: this is meant to work without anyone configuring it.
  const cleanup = opts.cleanup !== false
  let out = text
  if (cleanup) out = stripFillers(out)
  // User rules run after, so they act on the cleaned text and can still delete.
  if (rules.length) out = applyDictionary(out, rules)
  // Before tidy(), so the numerals it produces get the same spacing repair.
  if (opts.numbers) out = normalizeNumbers(out)
  if (cleanup || rules.length || opts.numbers) out = tidy(out)
  // Style last: tidy() re-capitalises the first character, which would undo it.
  if (opts.style && opts.style !== 'as-spoken') out = applyStyle(out, opts.style)
  return out
}
