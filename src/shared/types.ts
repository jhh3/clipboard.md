import { DEFAULT_DICTATE_CHORD } from './chord'

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

/**
 * How the AI cleanup key rewrites a transcript. 'standard' fixes mechanics only;
 * 'positive' additionally rewrites genuinely harsh text to be constructive, and
 * leaves everything else alone.
 */
export type EnhancePreset = 'standard' | 'positive' | 'custom'

export type ProviderId = 'openai' | 'fireworks'

export interface ProviderStatus {
  id: ProviderId
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
  /** AI tagging. Always the direct API, Fireworks first then OpenAI. */
  enrichment: {
    enabled: boolean
  }
  embeddings: { enabled: boolean }
  transcription: { provider: 'openai' | 'local' }
  linkEnrichment: boolean
  /** Optional Firecrawl key: upgrades link enrichment for JS-heavy pages. */
  firecrawlApiKey?: string
  /**
   * API keys for the api lane. Stored here because a desktop app launched by the
   * session never sees keys exported in a shell rc; the environment is still read as
   * a fallback. See modelport/openaiCompat.ts.
   */
  apiKeys?: { openai?: string; gemini?: string; fireworks?: string }
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
    /**
     * Corrections applied to every transcript, one rule per line:
     * `heard => written`, or a bare term to fix its spelling and casing.
     * Post-recognition on purpose — see src/main/dictionary.ts for why not hotwords.
     */
    dictionary?: string
    /**
     * Built-in tech proper-noun vocabulary (OpenAI, GitHub, Kubernetes…) applied on
     * top of the dictionary above. Undefined means on. Your own rules override it.
     */
    builtinVocabulary?: boolean
    /**
     * Strip hesitation sounds ("um", "uh") and repair the punctuation left behind.
     * Undefined means on: this is meant to work without being configured.
     */
    cleanup?: boolean
    /** Which AI cleanup preset the enhance key uses. Undefined = 'standard'. */
    enhancePreset?: EnhancePreset
    /**
     * Instructions for the 'custom' preset. Replaces the built-in behaviour rules;
     * the output contract ("return only the text") is always appended.
     */
    enhanceCustomPrompt?: string
    /** Output formatting. Undefined = 'as-spoken'. */
    style?: 'as-spoken' | 'casual'
    /** Spoken numbers to numerals ("twenty items" -> "20 items"). Undefined = on. */
    numbers?: boolean
    /**
     * Per-app style overrides, one per line: `wm-class-fragment => style`.
     * Empty by default, so an unconfigured install behaves the same everywhere.
     */
    profiles?: string
    /**
     * Learn from corrections: when you fix a mis-transcribed word shortly after a
     * transcript is pasted, propose a `heard => written` dictionary rule. Off by
     * default — it observes post-paste edits. Deterministic and offline (Phase 0).
     */
    learnCorrections?: boolean
    /** Correction suggestions the user dismissed, as `heard=>written` keys — never re-offered. */
    dismissedSuggestions?: string[]
  }
  /** Adapt pastes to the destination app (plain text into terminals, fenced code into chat). */
  smartPaste: boolean
  smartCollections: SmartCollection[]
  hotkeyHint: string
  /**
   * Push-to-talk chord, Linux only, as "Ctrl+Alt+Space" (see shared/chord.ts).
   *
   * Drives BOTH the GNOME keybinding and the evdev codes that observe the hold, so
   * the two cannot drift. macOS ignores it entirely: dictation there is the Fn/🌐
   * key via the helper's event tap, with ⌘⇧D as the toggle fallback.
   */
  dictateChord: string
  /** Optional second dictation chord that adds an AI cleanup pass. Empty = unbound. */
  dictateEnhanceChord?: string
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

/** A proposed dictation dictionary rule learned from a post-paste correction. */
export interface DictationSuggestion {
  /** `heard=>written` lowercased — dedupe/dismiss key. */
  key: string
  from: string
  to: string
  /** Short human reason ("sounds like what you dictated"). */
  reason: string
  /** The transcription clip this came from, if known. */
  itemId?: number
  at: number
}

/** IPC channel map: renderer -> main (invoke). */
export interface IpcInvokeMap {
  'dictation:suggestions:list': () => DictationSuggestion[]
  'dictation:suggestion:accept': (key: string) => void
  'dictation:suggestion:dismiss': (key: string) => void
  /** Keyword search: instant. The palette renders this first. */
  'search': (q: SearchQuery) => SearchResult
  /** Hybrid keyword + semantic search; slower (query embedding). Merged in after 'search'. */
  'search:semantic': (q: SearchQuery) => SearchResult
  'item:get': (id: number) => ClipItem | null
  'item:pin': (id: number, pinned: boolean) => void
  'item:delete': (id: number) => void
  'item:paste': (id: number, opts: { plain?: boolean }) => PasteOutcome
  'item:copy': (id: number) => void
  /** Full-resolution image as a data URL (thumb in ClipItem is capped at 320px). */
  'item:image-data': (id: number) => string | null
  /** Put text on the clipboard and paste it into the app underneath (ask answers). */
  'paste:text': (payload: { text: string }) => PasteOutcome
  /**
   * One-shot ask, streamed. Returns at once with a request id; the answer arrives as
   * 'ask:delta' events and ends with one 'ask:done'. itemId attaches a clip as context.
   */
  'ask:start': (payload: { text: string; itemId?: number }) => { id: string }
  'ask:cancel': (id: string) => void
  'collections:list': () => SmartCollection[]
  'settings:get': () => AppSettings
  'settings:set': (patch: Partial<AppSettings>) => AppSettings
  'providers:status': () => ProviderStatus[]
  'enrichment:status': () => EnrichmentStatus
  /** GNOME interactive screenshot portal (area/window/screen picker) -> new image clip id. */
  'capture:screenshot': () => { ok: boolean; id?: number; error?: string }
  /** Selection-rewrite flow: fetch the captured selection text (null if none). */
  'rewrite:get': () => { text: string } | null
  /** Rewrite the captured selection with a free-text instruction (empty = fix typos). */
  'rewrite:run': (payload: { prompt?: string }) => { ok: boolean; output?: string; error?: string }
  /** Replace the selection: clipboard + injection. */
  'rewrite:apply': (payload: { output: string }) => PasteOutcome
  /** Transcribe recorded audio (base64) -> text, for the palette mic. */
  'scratch:transcribe': (payload: { audioB64: string; mime: string }) => {
    ok: boolean
    text?: string
    error?: string
  }
  /** Dictation HUD: 16 kHz mono PCM of one take -> clip, then paste per settings. */
  'dictation:transcribe': (payload: {
    take: number
    pcm: Float32Array
    /** Start event to first captured audio, for the timing log. */
    micMs?: number
    /** A compressed copy follows on dictation:audio (keepAudio). */
    withAudio?: boolean
  }) => {
    ok: boolean
    text?: string
    error?: string
    pasted?: boolean
    id?: number
  }
  /** The compressed recording of a take, stored when keepAudio is on. */
  'dictation:audio': (payload: { take: number; audioB64: string; mime: string }) => void
  /** Retry transcription of a stored dictation recording. */
  'dictation:retry': (itemId: number) => { ok: boolean; text?: string; error?: string }
  /** Write the whole history to a JSON file the user picks. Secrets are excluded. */
  'data:export': () => { ok: boolean; path?: string; count?: number; error?: string }
  'window:hide': () => void
  /** Dictation HUD tells main a take finished (delivered, dropped or aborted). */
  'dictation:done': (take: number, reason?: string) => void
  /** Dictation HUD has subscribed to its events; queued start/stop can flow. */
  'dictation:ready': () => void
  'window:open-settings': () => void
  'app:version': () => string
}

/** IPC events: main -> renderer (send). */
export interface IpcEventMap {
  'items:changed': { reason: 'captured' | 'enriched' | 'deleted' | 'transformed' | 'shown' }
  'palette:shown': { collection?: string; mode?: 'normal' | 'rewrite'; rewriteText?: string }
  /** Sent right after hide, so the next show doesn't paint the previous query first. */
  'palette:hidden': Record<string, never>
  /** `take` ties every event of one dictation together, so a late event from the
   *  previous take can never stop or hide the current one. */
  'dictation:start': { take: number }
  'dictation:stop': { take: number }
  /** A chunk of a streamed ask answer. */
  'ask:delta': { id: string; text: string }
  /** The ask finished: the full answer, or why it failed. */
  'ask:done': { id: string; text?: string; error?: string }
  /** A dictation finished while the palette was open — its transcript becomes an
   *  ask instead of a paste. */
  'palette:dictation': { text: string }
  'toast': { message: string; kind: 'info' | 'error' | 'success' }
  /** The set of learned correction suggestions changed (new one, accept, dismiss). */
  'dictation:suggestions:changed': { suggestions: DictationSuggestion[] }
  /** Broadcast after any settings change so every window/service picks it up live. */
  'settings:changed': { settings: AppSettings }
}

export const DEFAULT_SETTINGS: AppSettings = {
  captureEnabled: true,
  pollIntervalMs: 400,
  // Matched as a case-insensitive SUBSTRING of the source app's name and id, which
  // is why there are no `.exe` variants here: `1password` already matches Windows'
  // `1password.exe`, and adding both would only suggest the matching is exact.
  // dashlane and lastpass are new — they have Windows desktop apps and were simply
  // missing, on every platform.
  ignoreApps: ['1password', 'keepassxc', 'bitwarden', 'dashlane', 'lastpass', 'gnome-keyring'],
  secretAutoClear: false,
  retentionDays: 365,
  maxItems: 50000,
  enrichment: { enabled: true },
  embeddings: { enabled: true },
  // Local Parakeet by default: fully offline, no audio ever leaves the machine, free.
  // First dictation downloads the ~490MB model once; switch to OpenAI in Settings to
  // skip the download at the cost of sending audio to their API.
  transcription: { provider: 'local' },
  linkEnrichment: true,
  // Empty: modelport/openaiCompat.ts holds the defaults; an entry here overrides one.
  models: {},
  dictation: { autoPaste: true, keepAudio: true },
  smartPaste: true,
  smartCollections: [],
  hotkeyHint: 'Ctrl+Alt+V',
  dictateChord: DEFAULT_DICTATE_CHORD,
  dictateEnhanceChord: '',
  theme: 'system',
  pasteInjection: 'portal'
}
