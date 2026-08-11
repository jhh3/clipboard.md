import { doubleMetaphone } from 'double-metaphone'

/**
 * Pure matching logic for "learn from corrections" — no electron, no settings, so it
 * is unit-testable in isolation. See corrections.ts for the stateful pipeline that
 * uses these, and docs/DICTATION-LEARNING.md for the design.
 */

const EDGE_PUNCT = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu

/**
 * Isolate a single localized word substitution between two strings.
 *
 * Trims the common prefix and suffix (by whitespace token) and returns the changed
 * span from each side, with edge punctuation stripped so "cloud," → "Claude," yields
 * the clean pair {cloud, Claude} (the caller re-verifies via a rule simulation).
 * Returns null for pure insertions/deletions, multi-region edits, or changes too
 * large to be one fix.
 */
export function singleSubstitution(
  original: string,
  edited: string
): { heard: string; written: string } | null {
  const oo = original.trim()
  const ee = edited.trim()
  if (!oo || !ee || oo === ee) return null
  const a = oo.split(/\s+/)
  const b = ee.split(/\s+/)

  let p = 0
  while (p < a.length && p < b.length && a[p] === b[p]) p++
  let sa = a.length - 1
  let sb = b.length - 1
  while (sa >= p && sb >= p && a[sa] === b[sb]) {
    sa--
    sb--
  }
  const heardTokens = a.slice(p, sa + 1)
  const writtenTokens = b.slice(p, sb + 1)
  if (!heardTokens.length || !writtenTokens.length) return null // pure insert/delete
  if (heardTokens.length > 3 || writtenTokens.length > 3) return null

  // Localized-change gate: for anything longer than a short phrase, the unchanged
  // prefix+suffix must dominate — otherwise it's a rewrite, not a fix.
  const unchanged = p + (a.length - 1 - sa)
  if (a.length > 4 && unchanged < Math.ceil(0.5 * a.length)) return null

  const heard = heardTokens.join(' ').replace(EDGE_PUNCT, '')
  const written = writtenTokens.join(' ').replace(EDGE_PUNCT, '')
  if (!heard || !written || heard === written) return null
  return { heard, written }
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'is', 'it', 'that', 'this', 'i', 'you'
])

/** A written form worth remembering: short, word-shaped, not just stopwords. */
export function plausibleWritten(written: string): boolean {
  const w = written.trim()
  if (!w || w.length > 40) return false
  if (!/^[\p{L}\p{N}.\-'/&+ ]+$/u.test(w)) return false
  const tokens = w.split(/\s+/)
  if (tokens.length < 1 || tokens.length > 3) return false
  if (tokens.every((t) => STOPWORDS.has(t.toLowerCase()))) return false
  return true
}

/**
 * Do two forms plausibly sound the same? This is what separates a transcription fix
 * ("cuber netes" → "kubernetes") from an unrelated rewrite. Three OR-ed tests, each
 * tight on its own; the caller's rule-simulation is the final backstop:
 *
 *  1. edit distance ≤ 1 — a letter or two off is clearly the same word mis-heard.
 *  2. Double Metaphone — models the digraph/silent-letter errors dictation makes
 *     (knight/night, cloud/Claude). Far higher precision than Soundex, and it still
 *     fires on domain jargon that surface-similarity would miss.
 *  3. Jaro-Winkler ≥ a tight floor — its prefix bonus fits ASR reality (onset heard
 *     right, tail flubbed). Short tokens get a higher bar, where the bonus is least
 *     reliable. We keep this OR-ed with phonetics rather than AND-ing them: English
 *     encoders butcher tech jargon, so a strict phonetic gate would drop exactly the
 *     jargon corrections that are our highest-value case.
 */
export function soundsAlike(heard: string, written: string): boolean {
  const h = heard.toLowerCase().replace(/[^a-z0-9]/g, '')
  const w = written.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (!h || !w) return false
  if (levenshtein(h, w) <= 1) return true
  if (metaphoneMatch(h, w)) return true
  const floor = Math.min(h.length, w.length) <= 4 ? 0.92 : 0.88
  return jaroWinkler(h, w) >= floor
}

/** True when the two words share any Double Metaphone code (primary or alternate). */
function metaphoneMatch(a: string, b: string): boolean {
  const codesB = doubleMetaphone(b)
  return doubleMetaphone(a).some((code) => code !== '' && codesB.includes(code))
}

export function levenshtein(a: string, b: string): number {
  const m = a.length
  const n = b.length
  if (!m) return n
  if (!n) return m
  let prev = Array.from({ length: n + 1 }, (_, i) => i)
  let curr = new Array<number>(n + 1)
  for (let i = 1; i <= m; i++) {
    curr[0] = i
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
    }
    ;[prev, curr] = [curr, prev]
  }
  return prev[n]
}

/** Jaro-Winkler similarity in [0,1]; the prefix bonus rewards a shared onset. */
export function jaroWinkler(a: string, b: string): number {
  const j = jaro(a, b)
  if (j < 0.7) return j
  let prefix = 0
  const max = Math.min(4, a.length, b.length)
  while (prefix < max && a[prefix] === b[prefix]) prefix++
  return j + prefix * 0.1 * (1 - j)
}

function jaro(a: string, b: string): number {
  if (a === b) return 1
  const la = a.length
  const lb = b.length
  if (!la || !lb) return 0
  const range = Math.max(0, Math.floor(Math.max(la, lb) / 2) - 1)
  const aMatched = new Array<boolean>(la).fill(false)
  const bMatched = new Array<boolean>(lb).fill(false)
  let matches = 0
  for (let i = 0; i < la; i++) {
    const lo = Math.max(0, i - range)
    const hi = Math.min(i + range + 1, lb)
    for (let k = lo; k < hi; k++) {
      if (bMatched[k] || a[i] !== b[k]) continue
      aMatched[i] = true
      bMatched[k] = true
      matches++
      break
    }
  }
  if (!matches) return 0
  let transpositions = 0
  let k = 0
  for (let i = 0; i < la; i++) {
    if (!aMatched[i]) continue
    while (!bMatched[k]) k++
    if (a[i] !== b[k]) transpositions++
    k++
  }
  transpositions /= 2
  return (matches / la + matches / lb + (matches - transpositions) / matches) / 3
}
