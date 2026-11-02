import { app } from 'electron'
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { DEFAULT_SETTINGS, type AppSettings, type ProviderId, type SmartCollection } from '@shared/types'

let cached: AppSettings | null = null
let filePath: string | null = null

export const DEFAULT_COLLECTIONS: SmartCollection[] = [
  { id: 'code', title: 'Code', classes: ['code', 'command'] },
  { id: 'links', title: 'Links', kinds: ['link'], classes: ['link'] },
  { id: 'errors', title: 'Errors', classes: ['error'] },
  { id: 'screenshots', title: 'Screenshots', classes: ['screenshot'] },
  { id: 'contact', title: 'Contact info', classes: ['contact', 'address'] }
]

function settingsFile(): string {
  if (!filePath) filePath = join(app.getPath('userData'), 'settings.json')
  return filePath
}

export function getSettings(): AppSettings {
  if (cached) return cached
  let raw: Record<string, unknown> | null = null
  try {
    raw = JSON.parse(readFileSync(settingsFile(), 'utf8'))
    cached = { ...DEFAULT_SETTINGS, ...raw }
  } catch (err) {
    const file = settingsFile()
    if (existsSync(file)) {
      // Don't quietly pretend this is a fresh install: preserve the damaged file
      // so the user's configuration can be recovered, and say so loudly.
      const backup = `${file}.corrupt-${Date.now()}`
      try {
        renameSync(file, backup)
        console.error(`[settings] unreadable settings file backed up to ${backup}:`, err)
      } catch (e) {
        console.error('[settings] unreadable settings file and backup failed:', e)
      }
    }
    cached = { ...DEFAULT_SETTINGS }
  }
  if (cached!.smartCollections.length === 0) cached!.smartCollections = DEFAULT_COLLECTIONS
  dropRetiredKeys(cached!)
  migrateProviderIds(cached!)
  return cached!
}

/**
 * Only direct-API providers remain (Fireworks, OpenAI). Settings files from earlier
 * builds carry the Claude agent / Codex / Gemini lanes, per-feature provider choices
 * and model ids that have since been retired (the pinned Fireworks id returned 404 and
 * every call silently fell back). Strip all of it so the built-in defaults apply.
 */
const VALID: ProviderId[] = ['fireworks', 'openai']
const RETIRED_MODELS = new Set([
  'accounts/fireworks/models/deepseek-v4-flash-0731',
  'gpt-5.6-luna',
  'gpt-4.1-mini',
  'gpt-4.1-nano'
])

function migrateProviderIds(s: AppSettings): void {
  let changed = false
  const models: AppSettings['models'] = {}
  for (const [id, model] of Object.entries(s.models ?? {})) {
    if (VALID.includes(id as ProviderId) && model && !RETIRED_MODELS.has(model)) models[id as ProviderId] = model
    else changed = true
  }
  s.models = models
  const legacy = s as unknown as Record<string, unknown>
  if ('transforms' in legacy) {
    delete legacy.transforms
    changed = true
  }
  const enrichment = s.enrichment as unknown as Record<string, unknown>
  if ('lane' in enrichment || 'provider' in enrichment) {
    s.enrichment = { enabled: s.enrichment.enabled !== false }
    changed = true
  }
  if (changed) {
    console.log('[settings] migrated AI provider settings to the direct-API lanes')
    // Scheduled rather than written inline — flushSettings serialises `cached`, which
    // is still being assembled by the load() call we are inside.
    scheduleFlush()
  }
}

/** Settings of features that were removed. Dropped so the file stops carrying them. */
const RETIRED_KEYS = [
  'agents',
  'assistant',
  'agentProfiles',
  'mcpServer',
  'sessionsEnabled',
  'voiceSamples',
  'imageEdit',
  'savedActions',
  'dictateAgentChord'
]

function dropRetiredKeys(s: AppSettings): void {
  const bag = s as unknown as Record<string, unknown>
  const found = RETIRED_KEYS.filter((k) => k in bag)
  if (found.length === 0) return
  for (const k of found) delete bag[k]
  scheduleFlush()
}

let flushTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Update in memory immediately; flush to disk on a short debounce so bursty callers
 * (window drags, slider drags in Settings) can't stall the main process on I/O.
 */
type SettingsListener = (s: AppSettings) => void
const listeners = new Set<SettingsListener>()

/** Subscribe to settings changes (windows, capture, embeddings — anything that
 *  previously only read settings once at startup and needed a restart to notice). */
export function onSettingsChanged(fn: SettingsListener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  const next = { ...getSettings(), ...patch }
  cached = next
  scheduleFlush()
  for (const fn of listeners) {
    try {
      fn(next)
    } catch (err) {
      console.error('[settings] listener failed:', err)
    }
  }
  return next
}

/** Coalesce writes: settings change in bursts as the user types in a field. */
function scheduleFlush(): void {
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = setTimeout(flushSettings, 250)
}

export function flushSettings(): void {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  if (!cached) return
  try {
    const file = settingsFile()
    mkdirSync(dirname(file), { recursive: true })
    // Write-then-rename: a crash mid-write used to leave truncated JSON, which
    // getSettings() would silently treat as "no settings", losing the user's saved
    // actions, voice samples, portal token and mic choice with no error.
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(cached, null, 2))
    renameSync(tmp, file)
  } catch (err) {
    console.error('[settings] write failed:', err)
  }
}

/** Test seam. */
export function _resetSettingsCache(): void {
  cached = null
  filePath = null
}
