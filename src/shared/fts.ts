/**
 * Escape user input for an FTS5 MATCH: quote each token, keep prefix matching on
 * the last. Shared by the app's search (store/items.ts) and the MCP bridge's
 * search_clipboard tool — one escaping rule, or the two searches drift.
 */
export function ftsQuery(q: string): string {
  const tokens = q
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
  if (tokens.length === 0) return ''
  tokens[tokens.length - 1] += '*'
  return tokens.join(' ')
}
