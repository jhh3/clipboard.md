import { useEffect, useState } from 'react'
import type { AppSettings } from '@shared/types'
import { invoke, on } from '../lib/ipc'

/**
 * Resolve the effective theme: explicit override (live settings edits) beats
 * the persisted setting, 'system' follows prefers-color-scheme.
 *
 * The persisted value stays live: main broadcasts 'settings:changed' after any
 * change, so a theme picked in Settings repaints every open window at once.
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
    const offSettings = on('settings:changed', (p) => setStored(p.settings.theme))
    return () => {
      mq.removeEventListener('change', onChange)
      offSettings()
    }
  }, [])

  const effective = override ?? stored ?? 'system'
  return effective === 'system' ? (sysDark ? 'dark' : 'light') : effective
}
