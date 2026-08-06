import { app } from 'electron'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { DEFAULT_SETTINGS, type AppSettings, type SavedAction, type SmartCollection } from '@shared/types'

let cached: AppSettings | null = null
let filePath: string | null = null

export const BUILTIN_ACTIONS: SavedAction[] = [
  { id: 'b-plain', title: 'Paste as plain text', key: 'p', type: 'builtin', builtinId: 'plain-text', appliesTo: ['text'] },
  { id: 'b-trim', title: 'Trim whitespace', key: 't', type: 'builtin', builtinId: 'trim', appliesTo: ['text'] },
  { id: 'b-lower', title: 'lowercase', key: 'l', type: 'builtin', builtinId: 'lowercase', appliesTo: ['text'] },
  { id: 'b-upper', title: 'UPPERCASE', key: 'u', type: 'builtin', builtinId: 'uppercase', appliesTo: ['text'] },
  { id: 'b-json', title: 'Pretty-print JSON', key: 'j', type: 'builtin', builtinId: 'json-pretty', appliesTo: ['text'] },
  { id: 'b-single', title: 'Join to single line', key: 's', type: 'builtin', builtinId: 'single-line', appliesTo: ['text'] },
  { id: 'ai-fix', title: 'Fix typos & grammar', key: 'f', type: 'prompt', appliesTo: ['text'],
    prompt: 'Fix spelling, grammar and punctuation. Preserve meaning, tone, formatting and line breaks exactly. Output only the corrected text.' },
  { id: 'ai-voice', title: 'Rewrite in my voice', key: 'v', type: 'prompt', appliesTo: ['text'],
    prompt: 'Rewrite this in my personal writing voice (samples provided in system context). Keep the meaning; output only the rewrite.' },
  { id: 'ai-concise', title: 'Make it concise', key: 'c', type: 'prompt', appliesTo: ['text'],
    prompt: 'Rewrite this more concisely without losing information. Output only the rewrite.' },
  { id: 'ai-summarize', title: 'Summarize', type: 'prompt', appliesTo: ['text'],
    prompt: 'Summarize this in a few sentences. Output only the summary.' },
  { id: 'ai-extract-urls', title: 'Extract URLs', type: 'prompt', appliesTo: ['text'],
    prompt: 'Extract all URLs, one per line. Output only the URLs.' },
  { id: 'b-img-png', title: 'Convert to PNG', type: 'builtin', builtinId: 'img-png', appliesTo: ['image'] },
  { id: 'b-img-jpg', title: 'Convert to JPEG', type: 'builtin', builtinId: 'img-jpeg', appliesTo: ['image'] },
  { id: 'ai-img-describe', title: 'Describe image', type: 'prompt', appliesTo: ['image'],
    prompt: 'Describe this image concisely, then list any text it contains.' }
]

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
  } catch {
    cached = { ...DEFAULT_SETTINGS }
  }
  if (cached!.savedActions.length === 0) cached!.savedActions = BUILTIN_ACTIONS
  if (cached!.smartCollections.length === 0) cached!.smartCollections = DEFAULT_COLLECTIONS
  return cached!
}

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  const next = { ...getSettings(), ...patch }
  cached = next
  const file = settingsFile()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(next, null, 2))
  return next
}

/** Test seam. */
export function _resetSettingsCache(): void {
  cached = null
  filePath = null
}
