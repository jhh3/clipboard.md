/**
 * Provider → environment variable, in a module that imports NOTHING.
 *
 * It lives alone because both keys.ts and shellEnv.ts need it, and keys.ts already
 * imports importShellEnv() from shellEnv.ts. Having shellEnv.ts import back from
 * keys.ts closed a cycle, so at module-init time the table was still undefined and a
 * top-level Object.values() over it threw "Cannot convert undefined or null to
 * object" — the app crash-looped before it could log a single line.
 *
 * Adding a provider means adding it here, and both the key lookup and the login-shell
 * import pick it up. Restating the list in shellEnv.ts is what let Fireworks be added
 * to one and not the other.
 */
export const PROVIDER_ENV_VARS = {
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
  fireworks: 'FIREWORKS_API_KEY'
} as const

export type KeyedProvider = keyof typeof PROVIDER_ENV_VARS
