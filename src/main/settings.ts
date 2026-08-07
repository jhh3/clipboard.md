import { app } from 'electron'
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { DEFAULT_SETTINGS, type AppSettings, type SavedAction, type SmartCollection } from '@shared/types'

let cached: AppSettings | null = null
let filePath: string | null = null

/** Ordered: the interesting AI actions lead; utilitarian builtins live below the fold. */
export const BUILTIN_ACTIONS: SavedAction[] = [
  { id: 'ai-fix', title: 'Fix typos & grammar', key: 'f', type: 'prompt', appliesTo: ['text'],
    prompt: 'Fix spelling, grammar and punctuation. Preserve meaning, tone, formatting and line breaks exactly. Output only the corrected text.' },
  { id: 'ai-voice', title: 'Rewrite in my voice', key: 'v', type: 'prompt', appliesTo: ['text'],
    prompt: 'Rewrite this in my personal writing voice (samples provided in system context). Keep the meaning; output only the rewrite.' },
  { id: 'ai-concise', title: 'Make it concise', key: 'c', type: 'prompt', appliesTo: ['text'],
    prompt: 'Rewrite this more concisely without losing information. Output only the rewrite.' },
  { id: 'ai-polish', title: 'Polish for work chat', key: 'w', type: 'prompt', appliesTo: ['text'],
    prompt: 'Lightly polish this message for a professional-but-casual work chat: fix errors, tighten wording, keep my phrasing and any code/links intact. Output only the message.' },
  { id: 'ai-explain', title: 'Explain this', key: 'x', type: 'prompt', appliesTo: ['text'],
    prompt: 'Explain what this text/code/error means in plain language, briefly.' },
  { id: 'ai-summarize', title: 'Summarize', type: 'prompt', appliesTo: ['text'],
    prompt: 'Summarize this in a few sentences. Output only the summary.' },
  { id: 'ai-table', title: 'To markdown table', type: 'prompt', appliesTo: ['text'],
    prompt: 'Convert this data into a clean markdown table. Output only the table.' },
  { id: 'ai-extract-urls', title: 'Extract URLs', type: 'prompt', appliesTo: ['text'],
    prompt: 'Extract all URLs, one per line. Output only the URLs.' },
  { id: 'b-plain', title: 'Paste as plain text', key: 'p', type: 'builtin', builtinId: 'plain-text', appliesTo: ['text'] },
  { id: 'b-json', title: 'Pretty-print JSON', key: 'j', type: 'builtin', builtinId: 'json-pretty', appliesTo: ['text'] },
  { id: 'b-single', title: 'Join to single line', key: 's', type: 'builtin', builtinId: 'single-line', appliesTo: ['text'] },
  { id: 'b-trim', title: 'Trim whitespace', key: 't', type: 'builtin', builtinId: 'trim', appliesTo: ['text'] },
  { id: 'b-img-redact', title: 'Auto-redact sensitive text', key: 'r', type: 'builtin', builtinId: 'img-redact', appliesTo: ['image'] },
  { id: 'ai-img-describe', title: 'Describe image', key: 'd', type: 'prompt', appliesTo: ['image'],
    prompt: 'Describe this image concisely, then list any text it contains.' },
  { id: 'b-img-jpg', title: 'Convert to JPEG', type: 'builtin', builtinId: 'img-jpeg', appliesTo: ['image'] },
  { id: 'b-img-png', title: 'Convert to PNG', type: 'builtin', builtinId: 'img-png', appliesTo: ['image'] },
  { id: 'b-img-compress', title: 'Compress (JPEG 70)', type: 'builtin', builtinId: 'img-compress', appliesTo: ['image'] }
]

/** Ids intentionally dropped from the defaults (uninteresting; users can re-add). */
const RETIRED_BUILTIN_IDS = new Set(['b-lower', 'b-upper'])

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
  try {
    const raw = JSON.parse(readFileSync(settingsFile(), 'utf8'))
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
  const stored = cached!.savedActions
  const isBuiltinId = (id: string): boolean => id.startsWith('b-') || id.startsWith('ai-')
  if (stored.length === 0 || stored.every((a) => isBuiltinId(a.id))) {
    // No user customizations: adopt the shipped set wholesale (order matters in the UI).
    cached!.savedActions = BUILTIN_ACTIONS
  } else {
    // User has custom actions: keep their list, merge new builtins, drop retired ones.
    const have = new Set(stored.map((a) => a.id))
    cached!.savedActions = [
      ...stored.filter((a) => !RETIRED_BUILTIN_IDS.has(a.id)),
      ...BUILTIN_ACTIONS.filter((b) => !have.has(b.id))
    ]
  }
  if (cached!.smartCollections.length === 0) cached!.smartCollections = DEFAULT_COLLECTIONS
  return cached!
}

let flushTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Update in memory immediately; flush to disk on a short debounce so bursty callers
 * (window drags, slider drags in Settings) can't stall the main process on I/O.
 */
export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  const next = { ...getSettings(), ...patch }
  cached = next
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = setTimeout(flushSettings, 250)
  return next
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
