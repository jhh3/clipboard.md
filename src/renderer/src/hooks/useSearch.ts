import { useCallback, useEffect, useRef, useState } from 'react'
import type { ClipKind, SearchResult } from '@shared/types'
import { invoke } from '../lib/ipc'

const EMPTY: SearchResult = { items: [], total: 0, mode: 'keyword' }
const LIMIT = 400

/**
 * Live search with stale-response protection. Keyword results render first (they
 * take a millisecond); hybrid results, which wait on a query embedding, replace them
 * when they arrive. `refresh` re-runs the current query (used on 'items:changed').
 */
export function useSearch(q: string, kind: ClipKind | 'all', collection: string | undefined) {
  const [result, setResult] = useState<SearchResult>(EMPTY)
  const seq = useRef(0)

  const refresh = useCallback(async () => {
    const ticket = ++seq.current
    const query = { q, kind, collection, limit: LIMIT }
    try {
      const res = await invoke('search', query)
      if (ticket !== seq.current) return
      setResult(res)
      if (!q.trim()) return
      const hybrid = await invoke('search:semantic', query)
      if (ticket === seq.current && hybrid.mode === 'hybrid') setResult(hybrid)
    } catch {
      // main process not ready / channel error — keep last good result
    }
  }, [q, kind, collection])

  useEffect(() => {
    // Keyword search is cheap enough to run per keystroke; a short debounce only
    // coalesces bursts of typing.
    const t = window.setTimeout(() => void refresh(), 30)
    return () => window.clearTimeout(t)
  }, [refresh])

  return { items: result.items, total: result.total, searchMode: result.mode, refresh }
}
