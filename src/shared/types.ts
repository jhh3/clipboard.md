/** Content classification assigned by capture heuristics and refined by AI enrichment. */
export type ClipKind = 'text' | 'image' | 'link' | 'code' | 'color' | 'files' | 'html'

export type ContentClass =
  | 'code'
  | 'link'
  | 'error'
  | 'address'
  | 'contact'
  | 'meeting'
  | 'prose'
  | 'command'
  | 'data'
  | 'secret'
  | 'screenshot'
  | 'photo'
  | 'other'

export interface ClipItem {
  id: number
  kind: ClipKind
  /** Text content, or absolute path to the stored image file for kind==='image'. */
  content: string
  /** Original HTML flavor when present (pasteboard rich text). */
  html?: string
  /** First ~500 chars for list rendering (text) — avoids shipping megabytes to the renderer. */
  preview: string
  /** Data URL thumbnail for images. */
  thumb?: string
  /** Image dimensions for kind==='image'. */
  width?: number
  height?: number
  sourceApp?: string
  createdAt: number
  lastCopiedAt: number
  copyCount: number
  pinned: boolean
  /** AI enrichment (nullable until the queue processes the item). */
  autoTitle?: string
  tags: string[]
  contentClass?: ContentClass
  ocrText?: string
  description?: string
  /** Language for code clips. */
  language?: string
  /** id of the clip this one was derived from via a transform. */
  derivedFrom?: number
  /** Transform label that produced this derived clip. */
  derivedVia?: string
  /** Flagged by secret heuristics: masked in UI, never enriched/embedded. */
  secret: boolean
  charCount: number
  enrichedAt?: number
  embeddedAt?: number
}

export type SearchMode = 'keyword' | 'hybrid'

export interface SearchQuery {
  q: string
  /** Filter by kind chip. */
  kind?: ClipKind | 'all'
  /** Smart collection id or 'pinned'. */
  collection?: string
  limit?: number
  offset?: number
  mode?: SearchMode
}

export interface SearchResult {
  items: ClipItem[]
  total: number
  /** Which mode actually ran (hybrid falls back to keyword when embeddings are cold). */
  mode: SearchMode
}

/** A saved action: deterministic transform or AI prompt, optionally bound to a key in Action Mode. */
export interface SavedAction {
  id: string
  title: string
  /** Single character binding inside Action Mode, e.g. 'p'. */
  key?: string
  /** 'builtin' runs a deterministic transform by builtinId; 'prompt' runs the AI lane. */
  type: 'builtin' | 'prompt'
  builtinId?: BuiltinTransformId
  prompt?: string
  /** Which clip kinds this action applies to. */
  appliesTo: Array<'text' | 'image'>
}

export type BuiltinTransformId =
  | 'plain-text'
  | 'trim'
  | 'lowercase'
  | 'uppercase'
  | 'title-case'
  | 'json-pretty'
  | 'json-minify'
  | 'url-encode'
  | 'url-decode'
  | 'base64-encode'
  | 'base64-decode'
  | 'strip-quotes'
  | 'single-line'
  | 'markdown-strip'
  | 'img-png'
  | 'img-jpeg'
  | 'img-compress'

export interface TransformRequest {
  itemId: number
  /** Either a saved action id, or a free-text AI prompt. */
  actionId?: string
  freePrompt?: string
}

export interface TransformResult {
  ok: boolean
  /** Preview of transformed content (full text, or data URL for images). */
  output?: string
  outputKind?: 'text' | 'image'
  /** id of the derived clip once committed. */
  derivedId?: number
  error?: string
}

export type ProviderLane = 'subscription' | 'api'
export type ProviderId = 'claude-cli' | 'codex-cli' | 'openai' | 'groq' | 'gemini'

export interface ProviderStatus {
  id: ProviderId
  lane: ProviderLane
  available: boolean
  detail: string
}

export interface EnrichmentStatus {
  enabled: boolean
  queued: number
  processed: number
  failed: number
  lastError?: string
}

export interface SmartCollection {
  id: string
  title: string
  /** Facet query: kinds/classes/tags this collection matches. */
  classes?: ContentClass[]
  kinds?: ClipKind[]
  /** Natural-language membership rule, evaluated at classification time into `tags`. */
  rule?: string
  tag?: string
  count?: number
}

export interface AppSettings {
  captureEnabled: boolean
  pollIntervalMs: number
  ignoreApps: string[]
  secretAutoClear: boolean
  retentionDays: number
  maxItems: number
  enrichment: {
    enabled: boolean
    lane: ProviderLane
    provider: ProviderId
  }
  transforms: {
    provider: ProviderId
  }
  embeddings: { enabled: boolean }
  voiceSamples: string[]
  savedActions: SavedAction[]
  smartCollections: SmartCollection[]
  hotkeyHint: string
  theme: 'system' | 'dark' | 'light'
  /** Linux auto-paste: 'portal' = XDG RemoteDesktop injection (one-time permission), 'off' = copy + toast. */
  pasteInjection: 'portal' | 'off'
  /** RemoteDesktop portal restore token — skips the permission dialog on later sessions. */
  pastePortalToken?: string
}

export interface PasteOutcome {
  method: 'injected' | 'copied'
  /** When 'copied', the UI shows a "press Ctrl+V" toast before hiding. */
  message?: string
}

/** IPC channel map: renderer -> main (invoke). */
export interface IpcInvokeMap {
  'search': (q: SearchQuery) => SearchResult
  'item:get': (id: number) => ClipItem | null
  'item:pin': (id: number, pinned: boolean) => void
  'item:delete': (id: number) => void
  'item:paste': (id: number, opts: { plain?: boolean }) => PasteOutcome
  'item:copy': (id: number) => void
  'transform:run': (req: TransformRequest) => TransformResult
  'transform:commit': (req: TransformRequest & { output: string; outputKind: 'text' | 'image' }) => number
  'transform:paste-output': (payload: { output: string; outputKind: 'text' | 'image' }) => PasteOutcome
  'actions:list': (kind: 'text' | 'image') => SavedAction[]
  'actions:save': (action: SavedAction) => void
  'actions:delete': (id: string) => void
  'collections:list': () => SmartCollection[]
  'settings:get': () => AppSettings
  'settings:set': (patch: Partial<AppSettings>) => AppSettings
  'providers:status': () => ProviderStatus[]
  'enrichment:status': () => EnrichmentStatus
  'window:hide': () => void
  'app:version': () => string
}

/** IPC events: main -> renderer (send). */
export interface IpcEventMap {
  'items:changed': { reason: 'captured' | 'enriched' | 'deleted' | 'transformed' }
  'palette:shown': { collection?: string }
  'toast': { message: string; kind: 'info' | 'error' | 'success' }
}

export const DEFAULT_SETTINGS: AppSettings = {
  captureEnabled: true,
  pollIntervalMs: 400,
  ignoreApps: ['1password', 'keepassxc', 'bitwarden', 'gnome-keyring'],
  secretAutoClear: false,
  retentionDays: 365,
  maxItems: 50000,
  enrichment: { enabled: true, lane: 'subscription', provider: 'claude-cli' },
  transforms: { provider: 'groq' },
  embeddings: { enabled: true },
  voiceSamples: [],
  savedActions: [],
  smartCollections: [],
  hotkeyHint: 'Ctrl+Alt+V',
  theme: 'system',
  pasteInjection: 'portal'
}
