import { getSettings, updateSettings } from '../settings'
import { importShellEnv } from '../shellEnv'

/**
 * API keys come from Settings. Only Settings.
 *
 * The environment is read exactly once, at startup, to SEED a key that Settings does
 * not already have — after that nothing in the app looks at it again.
 *
 * The previous design read Settings with an environment fallback at each call site,
 * which meant a feature's behaviour depended on how the app happened to be launched:
 * started from a terminal it saw your exported keys, started by the session (an
 * autostart entry, a .desktop launcher, systemd) it saw nothing, and the only symptom
 * was "no providers available" while `echo $OPENAI_API_KEY` printed one. It also had
 * to be remembered at every call site, and it was not: chat completions were
 * converted while transcription and image analysis kept reading the environment, so
 * which features worked depended on which file had been updated.
 *
 * Seeding makes the key visible and editable in Settings, and identical no matter how
 * the app was started.
 */
const ENV_VAR = {
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
  fireworks: 'FIREWORKS_API_KEY'
} as const

export type KeyedProvider = keyof typeof ENV_VAR

/** The key for a provider, or undefined. Settings is the only source. */
export function apiKeyFor(provider: KeyedProvider): string | undefined {
  return getSettings().apiKeys?.[provider]?.trim() || undefined
}

/**
 * Copy keys out of the environment into Settings, once, for providers that do not
 * have one yet. Never overwrites a key the user set — Settings always wins.
 *
 * Must run AFTER importShellEnv() on macOS, which is what puts the login shell's
 * exports into this process in the first place.
 */
export async function seedApiKeys(): Promise<void> {
  // Nothing missing? Do not spawn a login shell just to confirm that.
  const have = getSettings().apiKeys ?? {}
  const missing = (Object.keys(ENV_VAR) as KeyedProvider[]).filter((p) => !have[p]?.trim())
  if (missing.length === 0) return
  // Only worth the shell round-trip if the environment we already have is no help.
  if (missing.some((p) => !process.env[ENV_VAR[p]]?.trim())) await importShellEnv()
  seedFromEnv()
}

function seedFromEnv(): void {
  const current = getSettings().apiKeys ?? {}
  const next = { ...current }
  const seeded: string[] = []
  for (const provider of Object.keys(ENV_VAR) as KeyedProvider[]) {
    if (next[provider]?.trim()) continue
    const fromEnv = process.env[ENV_VAR[provider]]?.trim()
    if (!fromEnv) continue
    next[provider] = fromEnv
    seeded.push(provider)
  }
  if (seeded.length === 0) return
  updateSettings({ apiKeys: next })
  console.log(`[settings] seeded ${seeded.join(', ')} key(s) from the environment`)
}

/** Human-readable state, for status text that has to be actionable. */
export function apiKeySource(provider: KeyedProvider): string {
  return apiKeyFor(provider) ? 'Settings' : `no key — add one in Settings (or export ${ENV_VAR[provider]})`
}
