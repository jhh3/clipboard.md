import { useEffect, useState } from 'react'
import type { AppSettings } from '@shared/types'
import { invoke } from '../lib/ipc'

/**
 * Resolve the effective theme: explicit override (live settings edits) beats
 * the persisted setting, 'system' follows prefers-color-scheme.
 */
export function useTheme(override?: AppSettings['theme']): 'dark' | 'light' {
  const [stored, setStored] = useState<AppSettings['theme'] | null>(null)
  const [sysDark, setSysDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches
  )

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => setSysDark(mq.matches)
    mq.addEventListener('change', onChange)
    invoke('settings:get')
      .then((s) => setStored(s.theme))
      .catch(() => {})
    return () => mq.removeEventListener('change', onChange)
  }, [])

  const effective = override ?? stored ?? 'system'
  return effective === 'system' ? (sysDark ? 'dark' : 'light') : effective
}
