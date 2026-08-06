import { useCallback, useEffect, useRef, useState } from 'react'
import type { ClipKind, SearchResult } from '@shared/types'
import { invoke } from '../lib/ipc'

const EMPTY: SearchResult = { items: [], total: 0, mode: 'keyword' }
const LIMIT = 400

/**
 * Live search with an 80ms debounce and stale-response protection.
 * `refresh` re-runs the current query immediately (used on 'items:changed').
 */
export function useSearch(q: string, kind: ClipKind | 'all', collection: string | undefined) {
  const [result, setResult] = useState<SearchResult>(EMPTY)
  const seq = useRef(0)

  const refresh = useCallback(async () => {
    const ticket = ++seq.current
    try {
      const res = await invoke('search', { q, kind, collection, limit: LIMIT })
      if (ticket === seq.current) setResult(res)
    } catch {
      // main process not ready / channel error — keep last good result
    }
  }, [q, kind, collection])

  useEffect(() => {
    const t = window.setTimeout(() => void refresh(), 80)
    return () => window.clearTimeout(t)
  }, [refresh])

  return { items: result.items, total: result.total, searchMode: result.mode, refresh }
}
