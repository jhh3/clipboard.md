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
 * Do two forms plausibly sound the same? A small normalized edit distance OR a
 * matching Soundex code. This separates a transcription fix ("cuber netes" →
 * "kubernetes") from an unrelated rewrite.
 */
export function soundsAlike(heard: string, written: string): boolean {
  const h = heard.toLowerCase().replace(/[^a-z0-9]/g, '')
  const w = written.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (!h || !w) return false
  if (levRatio(h, w) <= 0.5) return true
  const sh = soundex(h)
  return sh !== '' && sh === soundex(w)
}

function levRatio(a: string, b: string): number {
  const max = Math.max(a.length, b.length)
  return max === 0 ? 0 : levenshtein(a, b) / max
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

const SOUNDEX_CODE: Record<string, string> = {
  B: '1', F: '1', P: '1', V: '1',
  C: '2', G: '2', J: '2', K: '2', Q: '2', S: '2', X: '2', Z: '2',
  D: '3', T: '3',
  L: '4',
  M: '5', N: '5',
  R: '6'
}

export function soundex(s: string): string {
  const a = s.toUpperCase().replace(/[^A-Z]/g, '')
  if (!a) return ''
  let out = a[0]
  let prev = SOUNDEX_CODE[a[0]] ?? ''
  for (let i = 1; i < a.length && out.length < 4; i++) {
    const code = SOUNDEX_CODE[a[i]] ?? ''
    if (code && code !== prev) out += code
    if (a[i] !== 'H' && a[i] !== 'W') prev = code
  }
  return (out + '000').slice(0, 4)
}
