/**
 * Escape user input for an FTS5 MATCH: quote each token, keep prefix matching on
 * the last when it has at least two characters (a one-letter prefix matches most of
 * the index and then has to rank all of it; one letter matches that exact word). Shared by the app's search (store/items.ts) and the MCP bridge's
 * search_clipboard tool — one escaping rule, or the two searches drift.
 */
export function ftsQuery(q: string): string {
  const tokens = q
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
  if (tokens.length === 0) return ''
  const last = tokens[tokens.length - 1]
  // Length of the quoted token minus its quotes.
  if (last.length - 2 >= 2) tokens[tokens.length - 1] += '*'
  return tokens.join(' ')
}
