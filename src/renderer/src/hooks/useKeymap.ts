import { useEffect, useRef } from 'react'

/**
 * Attach a window-level keydown handler that always sees the latest render's
 * closure (via a ref), without re-subscribing every render.
 */
export function useKeymap(handler: (e: KeyboardEvent) => void): void {
  const ref = useRef(handler)
  ref.current = handler
  useEffect(() => {
    const fn = (e: KeyboardEvent) => ref.current(e)
    window.addEventListener('keydown', fn)
    return () => window.removeEventListener('keydown', fn)
  }, [])
}
