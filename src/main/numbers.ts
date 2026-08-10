/**
 * Inverse text normalisation: spoken numbers to numerals.
 *
 * Parakeet emits numbers as words, always — measured across 76 real dictations here,
 * zero contained a numeral. So "twenty tech debt items" arrives spelled out and has to
 * be converted afterwards if we want it converted at all.
 *
 * The conversion is deliberately CONSERVATIVE, because those same 76 transcripts show
 * that most spoken numbers should stay as words:
 *
 *   "a one click install"          <- "1 click install" is wrong
 *   "one of my agents"             <- "1 of my agents" is wrong
 *   "split into two dictations"    <- "2 dictations" is worse
 *   "another twenty tech debt items"   <- "20 tech debt items" is RIGHT
 *
 * A blanket words-to-digits pass would corrupt three of those to fix one. So this
 * follows the ordinary prose convention instead: spell out one to nine, use numerals
 * from ten up, and always use numerals when a unit, currency, percentage or time is
 * attached — which is exactly the line those transcripts already sit on.
 */

const ONES: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19
}
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80,
  ninety: 90
}
const SCALES: Record<string, number> = { hundred: 100, thousand: 1000, million: 1000000, billion: 1000000000 }

const NUMBER_WORD = new RegExp(
  `\\b(?:${[...Object.keys(ONES), ...Object.keys(TENS), ...Object.keys(SCALES), 'and']
    .join('|')})\\b`,
  'i'
)

/** Units and suffixes that force a numeral regardless of how small the value is. */
const UNIT_AFTER =
  /^(?:%|percent|percents|dollars?|euros?|pounds?|cents?|kb|mb|gb|tb|ms|hz|khz|mhz|ghz|px|pt|em|rem|mm|cm|km|kg|lbs?|oz|ft|inch|inches|minutes?|mins?|seconds?|secs?|hours?|hrs?|days?|weeks?|months?|years?|times|x)$/i
const CURRENCY_BEFORE = /(?:\$|£|€)$/

/** Parse a run of number words into a value, or null if it isn't a clean number. */
function wordsToNumber(words: string[]): number | null {
  let total = 0
  let current = 0
  let seen = false
  for (const raw of words) {
    const w = raw.toLowerCase()
    if (w === 'and') continue
    if (w in ONES) {
      current += ONES[w]
      seen = true
    } else if (w in TENS) {
      current += TENS[w]
      seen = true
    } else if (w in SCALES) {
      if (!seen) current = 1 // "hundred items" -> 100
      const scale = SCALES[w]
      if (scale >= 1000) {
        total += current * scale
        current = 0
      } else {
        current *= scale
      }
      seen = true
    } else {
      return null
    }
  }
  return seen ? total + current : null
}

/**
 * Convert spoken numbers in a transcript.
 *
 * Values below ten stay as words unless a unit, currency or percentage is attached —
 * "five minutes" becomes "5 minutes" while "five of them" is left alone.
 */
export function normalizeNumbers(text: string): string {
  if (!NUMBER_WORD.test(text)) return text

  const tokenRe = /\b[A-Za-z]+\b/g
  const tokens: Array<{ word: string; start: number; end: number }> = []
  let m: RegExpExecArray | null
  while ((m = tokenRe.exec(text)) !== null) {
    tokens.push({ word: m[0], start: m.index, end: m.index + m[0].length })
  }

  const isNumWord = (w: string): boolean => {
    const l = w.toLowerCase()
    return l in ONES || l in TENS || l in SCALES
  }

  const out: Array<{ start: number; end: number; text: string }> = []
  for (let i = 0; i < tokens.length; i++) {
    if (!isNumWord(tokens[i].word)) continue
    // Extend over the whole spoken number, allowing a joining "and".
    let j = i
    while (j + 1 < tokens.length) {
      const next = tokens[j + 1].word.toLowerCase()
      const between = text.slice(tokens[j].end, tokens[j + 1].start)
      if (!/^[\s-]*$/.test(between)) break // punctuation ends the run
      if (isNumWord(next)) j++
      else if (next === 'and' && j + 2 < tokens.length && isNumWord(tokens[j + 2].word)) j += 2
      else break
    }
    const span = tokens.slice(i, j + 1)
    const value = wordsToNumber(span.map((t) => t.word))
    i = j
    if (value === null) continue

    const before = text.slice(0, span[0].start).trimEnd()
    const after = text.slice(span[span.length - 1].end).trimStart()
    const nextWord = after.match(/^[A-Za-z%]+/)?.[0] ?? ''
    const forced = UNIT_AFTER.test(nextWord) || CURRENCY_BEFORE.test(before)
    // The convention: words below ten, numerals from ten up, numerals with a unit.
    if (value < 10 && !forced) continue
    out.push({ start: span[0].start, end: span[span.length - 1].end, text: String(value) })
  }

  if (out.length === 0) return text
  let result = ''
  let cursor = 0
  for (const r of out) {
    result += text.slice(cursor, r.start) + r.text
    cursor = r.end
  }
  return result + text.slice(cursor)
}
