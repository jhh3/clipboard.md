/** Content classification assigned by capture heuristics and refined by AI enrichment. */
export type ClipKind = 'text' | 'image' | 'link' | 'code' | 'color' | 'files' | 'html'

export type ContentClass =
  | 'transcription'
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
  /** Optional per-action provider override (falls back to the transforms default). */
  provider?: ProviderId
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
  | 'img-redact'

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
export type ProviderId = 'claude-agent' | 'codex' | 'openai' | 'gemini'

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

export interface SessionInfo {
  id: number
  title: string | null
  startedAt: number
  endedAt: number
  count: number
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
  transcription: { provider: 'openai' | 'local' }
  linkEnrichment: boolean
  /** Optional Firecrawl key: upgrades link enrichment for JS-heavy pages. */
  firecrawlApiKey?: string
  sessionsEnabled: boolean
  /** Per-provider model overrides (fast models by default). */
  models: Partial<Record<ProviderId, string>>
  /** Saved geometry per aux window (hash route -> bounds). */
  windowBounds?: Record<string, { x: number; y: number; width: number; height: number }>
  dictation: {
    /** Auto-paste the transcript into the focused app when injection is available. */
    autoPaste: boolean
    /** Keep the recorded audio file so a transcript can be retried. */
    keepAudio: boolean
    /** MediaDevices deviceId for the mic; empty = system default. */
    deviceId?: string
    /** Human-readable label of the chosen mic, for display when it's unplugged. */
    deviceLabel?: string
  }
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
  /** Full-resolution image as a data URL (thumb in ClipItem is capped at 320px). */
  'item:image-data': (id: number) => string | null
  'transform:run': (req: TransformRequest) => TransformResult
  'transform:commit': (req: TransformRequest & { output: string; outputKind: 'text' | 'image' }) => number
  'transform:paste-output': (payload: { output: string; outputKind: 'text' | 'image'; plain?: boolean }) => PasteOutcome
  'actions:list': (kind: 'text' | 'image') => SavedAction[]
  'actions:save': (action: SavedAction) => void
  'actions:delete': (id: string) => void
  'collections:list': () => SmartCollection[]
  'sessions:list': () => SessionInfo[]
  'settings:get': () => AppSettings
  'settings:set': (patch: Partial<AppSettings>) => AppSettings
  'providers:status': () => ProviderStatus[]
  'enrichment:status': () => EnrichmentStatus
  /** GNOME interactive screenshot portal (area/window/screen picker) -> new image clip id. */
  'capture:screenshot': () => { ok: boolean; id?: number; error?: string }
  /** Selection-rewrite flow: fetch the captured selection text (null if none). */
  'rewrite:get': () => { text: string } | null
  /** Replace the selection: clipboard + injection. */
  'rewrite:apply': (payload: { output: string }) => PasteOutcome
  /** Transcribe recorded audio (base64) -> text. Also used by the dictation overlay. */
  'scratch:transcribe': (payload: {
    audioB64: string
    mime: string
    /** Dictation flow: save as a transcription clip and auto-paste per settings. */
    dictation?: boolean
  }) => { ok: boolean; text?: string; error?: string; pasted?: boolean; id?: number }
  /** Retry transcription of a stored dictation recording. */
  'dictation:retry': (itemId: number) => { ok: boolean; text?: string; error?: string }
  /** Save scratchpad text as a clip (new, or as a derived edit of itemId). */
  'scratch:save': (payload: { text: string; itemId?: number }) => number
  /** Write the whole history to a JSON file the user picks. Secrets are excluded. */
  'data:export': () => { ok: boolean; path?: string; count?: number; error?: string }
  'window:hide': () => void
  /** Dictation HUD tells main it finished (transcript delivered or aborted). */
  'dictation:done': () => void
  'window:open-settings': () => void
  'window:open-scratchpad': (itemId?: number) => void
  'app:version': () => string
}

/** IPC events: main -> renderer (send). */
export interface IpcEventMap {
  'items:changed': { reason: 'captured' | 'enriched' | 'deleted' | 'transformed' }
  'palette:shown': { collection?: string; mode?: 'normal' | 'rewrite'; rewriteText?: string }
  'scratchpad:shown': { itemId?: number }
  'dictation:start': Record<string, never>
  'dictation:stop': Record<string, never>
  'toast': { message: string; kind: 'info' | 'error' | 'success' }
  /** Broadcast after any settings change so every window/service picks it up live. */
  'settings:changed': { settings: AppSettings }
}

export const DEFAULT_SETTINGS: AppSettings = {
  captureEnabled: true,
  pollIntervalMs: 400,
  ignoreApps: ['1password', 'keepassxc', 'bitwarden', 'gnome-keyring'],
  secretAutoClear: false,
  retentionDays: 365,
  maxItems: 50000,
  enrichment: { enabled: true, lane: 'subscription', provider: 'claude-agent' },
  transforms: { provider: 'openai' },
  embeddings: { enabled: true },
  transcription: { provider: 'openai' },
  linkEnrichment: true,
  sessionsEnabled: true,
  // Fast-by-default: haiku on the Claude lane, Luna on OpenAI, flash-lite on Gemini.
  models: { 'claude-agent': 'haiku', openai: 'gpt-5.6-luna', gemini: 'gemini-flash-lite-latest' },
  dictation: { autoPaste: true, keepAudio: true },
  voiceSamples: [],
  savedActions: [],
  smartCollections: [],
  hotkeyHint: 'Ctrl+Alt+V',
  theme: 'system',
  pasteInjection: 'portal'
}
