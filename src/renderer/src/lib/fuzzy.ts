/**
 * Tiny subsequence fuzzy matcher. Good enough for filtering a couple dozen
 * saved actions — no external lib.
 */

/** Returns a match score (higher = better) or -1 when `query` is not a subsequence of `target`. */
export function fuzzyScore(query: string, target: string): number {
  const q = query.trim().toLowerCase()
  const t = target.toLowerCase()
  if (!q) return 0
  let qi = 0
  let score = 0
  let run = 0
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      run++
      // consecutive-run bonus + word/start boundary bonus
      score += 1 + run * 2
      if (ti === 0 || t[ti - 1] === ' ' || t[ti - 1] === '-' || t[ti - 1] === '_') score += 6
      qi++
    } else {
      run = 0
    }
  }
  return qi === q.length ? score : -1
}

/** Filter + rank a list by fuzzy score against `query`. Empty query returns the list unchanged. */
export function fuzzyFilter<T>(items: T[], query: string, key: (item: T) => string): T[] {
  if (!query.trim()) return items
  return items
    .map((item) => [item, fuzzyScore(query, key(item))] as const)
    .filter(([, s]) => s >= 0)
    .sort((a, b) => b[1] - a[1])
    .map(([item]) => item)
}
