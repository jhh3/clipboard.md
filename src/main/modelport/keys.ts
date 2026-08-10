import { getSettings } from '../settings'

/**
 * The one place an API key is resolved: Settings first, environment second.
 *
 * Environment-only was unworkable. A desktop app is started by the session — an
 * autostart entry, a .desktop launcher, systemd — none of which source a shell rc,
 * so a key exported in ~/.zshrc is invisible while `echo $OPENAI_API_KEY` in a
 * terminal prints one. macOS additionally imports the login shell's environment
 * (see shellEnv.ts); Linux has only this.
 *
 * It lives in its own module because it was previously duplicated per call site and
 * three of them were missed when keys moved into Settings — chat completions worked
 * while transcription and image analysis both reported "GEMINI_API_KEY not set" with
 * the key sitting in the settings file.
 */
const ENV_VAR = {
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY'
} as const

export type KeyedProvider = keyof typeof ENV_VAR

export function apiKeyFor(provider: KeyedProvider): string | undefined {
  const fromSettings = getSettings().apiKeys?.[provider]?.trim()
  return fromSettings || process.env[ENV_VAR[provider]] || undefined
}

/** Where the key came from, for status text that has to be actionable. */
export function apiKeySource(provider: KeyedProvider): string {
  if (getSettings().apiKeys?.[provider]?.trim()) return 'Settings'
  return process.env[ENV_VAR[provider]] ? ENV_VAR[provider] : `no key in Settings or ${ENV_VAR[provider]}`
}
