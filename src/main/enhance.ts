import { complete } from './modelport'

/**
 * The AI half of dictation cleanup — the corrections a regex provably cannot make.
 *
 * Bound to its own hotkey rather than a setting, so the default dictation path stays
 * offline and predictable and you choose the network per utterance, by choosing which
 * button to hold.
 *
 * It exists for exactly three things the deterministic pass refuses to attempt:
 *  - self-corrections ("Tuesday, no, Wednesday"), where a pattern cannot tell a
 *    correction from ordinary speech ("no, I agree")
 *  - discourse fillers ("like", "you know", "basically"), which are also real words
 *  - mis-heard words that only context can resolve
 *
 * The prompt is deliberately narrow. Every comparable tool converges on the same
 * instruction — fix mechanics, never restructure — because a model given latitude
 * will summarise or "improve" dictation into something the user did not say, and the
 * failure is invisible: the text reads well, it just isn't theirs.
 */
const SYSTEM = [
  'You clean up dictated speech. Apply only these changes:',
  '- remove filler words and false starts',
  '- when the speaker corrects themselves, keep only the corrected version',
  '- fix punctuation, capitalisation, and words that were clearly misheard',
  '- when the speaker enumerates items out loud ("one ... two ... three ...",',
  '  "first ... second ...", or "bullet ..."), format them as a real list: put the',
  '  lead-in on its own line ending with a colon, then one item per line numbered',
  '  "1." "2." "3." (or "- " for unnumbered ones). Use the speaker\'s own words for',
  '  each item and drop the spoken number word itself.',
  'Never add, remove, summarise, reorder or reword anything else.',
  'Do not invent a list where the speaker did not enumerate one.',
  'Preserve the speaker\'s wording, tone and register exactly.',
  'Return only the cleaned text, with no preamble, quotes or explanation.'
].join('\n')

/**
 * Longest transcript worth sending. Past this it is a monologue rather than a
 * dictated message, the latency stops feeling instant, and the risk of the model
 * quietly summarising rises with length.
 */
const MAX_CHARS = 4000

export async function enhanceTranscript(text: string): Promise<string> {
  const trimmed = text.trim()
  if (!trimmed || trimmed.length > MAX_CHARS) return text
  const out = await complete('transforms', { prompt: trimmed, system: SYSTEM })
  const cleaned = out.trim()
  // A model that returns nothing, or answers the text instead of cleaning it, must not
  // replace the user's words. Length is a crude but effective guard against both.
  if (!cleaned || cleaned.length > trimmed.length * 2) {
    console.error('[dictate] AI cleanup returned an implausible result; keeping the original')
    return text
  }
  return cleaned
}
