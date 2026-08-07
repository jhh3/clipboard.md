import { useCallback, useRef, useState } from 'react'
import type { Toast } from '../components/Toasts'

const TOAST_MS = 2500

/** Shared toast queue: auto-expiring messages rendered by <Toasts />. */
export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([])
  const seq = useRef(0)

  const addToast = useCallback((message: string, kind: Toast['kind'] = 'info') => {
    const id = ++seq.current
    setToasts((ts) => [...ts, { id, message, kind }])
    window.setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), TOAST_MS)
  }, [])

  return { toasts, addToast }
}
