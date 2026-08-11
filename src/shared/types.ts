import { DEFAULT_DICTATE_CHORD } from './chord'

/** Content classification assigned by capture heuristics and refined by AI enrichment. */
export type ClipKind = 'text' | 'image' | 'link' | 'code' | 'color' | 'files' | 'html' | 'note'

/**
 * A note is an item with kind='note' — see store/notes.ts. It differs from a clip in
 * three ways: it has a user-authored title, it is edited in place rather than being
 * append-only history, and its body can link to other notes with [[wikilinks]].
 */
export interface Note {
  id: number
  title: string
  content: string
  createdAt: number
  updatedAt: number
  pinned: boolean
  tags: string[]
}

/**
 * An agent definition: spawn recipe + persona. Deliberately carries no model:
 * sessions inherit the CLI default so definitions don't drift as it changes.
 *
 * The first definition in the list is the PRIMARY — the palette's default ask
 * target, and the owner of the main memory file.
 */
export interface AgentDef {
  name: string
  /** Where the session runs. Empty means the home directory. */
  cwd: string
  /** Extra directories the agent may touch, passed as --add-dir. */
  addDirs?: string[]
  /** Default true — these are sessions launched explicitly to work unattended. */
  bypassPermissions?: boolean
  /** Default true when tmux is installed, so the TUI stays attachable. */
  tmux?: boolean
  appendSystemPrompt?: string
  /** What this agent is for. Shown in pickers — and the signal a future
   *  auto-router will classify ask text against. Write it like routing rules. */
  description?: string
  /** Persona injected into the session's system prompt (with identityFiles). */
  identity?: string
  identityFiles?: string[]
  /** 'own' = private memory file · 'shared' = read/write the primary's file ·
   *  'off' (default for non-primary) = no long-term memory. */
  memory?: 'own' | 'shared' | 'off'
  /** Keep a named singleton session the ask row can target (default true). */
  persistent?: boolean
  /** Launch the singleton at app start so the first ask is instant. */
  prewarm?: boolean
}

/** Back-compat alias — the spawn-recipe subset predates personas. */
export type AgentProfile = AgentDef

export interface AgentSession {
  key: string
  profile: string
  cwd: string
  title: string | null
  /** dormant = slept to reclaim memory, resumable via `claude --resume`. */
  status: 'starting' | 'running' | 'dormant' | 'exited'
  createdAt: number
  lastSeenAt: number
  unread: number
  /** The bridge has published its port, so this session can be spoken to. */
  reachable: boolean
}

export interface AgentMessage {
  id: number
  sessionKey: string
  direction: 'inbound' | 'outbound'
  kind: string
  body: string
  meta?: Record<string, unknown>
  createdAt: number
  readAt: number | null
}

/** Notes list row — body replaced by its preview, so the sidebar stays cheap. */
export interface NoteSummary {
  id: number
  title: string
  preview: string
  createdAt: number
  updatedAt: number
  pinned: boolean
  tags: string[]
}

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
  /** With freePrompt on an image clip: route to the image-EDITING model (the
   *  prompt is an edit instruction, the output is a new image). */
  imageEdit?: boolean
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

/**
 * How the AI cleanup key rewrites a transcript. 'standard' fixes mechanics only;
 * 'positive' additionally rewrites genuinely harsh text to be constructive, and
 * leaves everything else alone.
 */
export type EnhancePreset = 'standard' | 'positive'

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
  /**
   * API keys for the api lane. Stored here because a desktop app launched by the
   * session never sees keys exported in a shell rc; the environment is still read as
   * a fallback. See modelport/openaiCompat.ts.
   */
  apiKeys?: { openai?: string; gemini?: string }
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
  voiceSamples: string[]
  /**
   * Agent definitions; agents[0] is the primary. Canonical home for identity —
   * the legacy `assistant` block below migrates into agents[0] on first load.
   */
  agents: AgentDef[]
  /** LEGACY (pre-multi-agent): folded into agents[0] by getSettings(). */
  assistant: {
    identity: string
    /** Absolute paths to markdown/text files appended to the identity. */
    identityFiles: string[]
    /** Start the assistant session at app launch so the first ask is instant. */
    prewarm: boolean
  }
  /** Adapt pastes to the destination app (plain text into terminals, fenced code into chat). */
  smartPaste: boolean
  /** AI image editing (palette: `e` on an image clip). Model '' = provider default. */
  imageEdit: { provider: 'gemini' | 'openai'; model?: string }
  savedActions: SavedAction[]
  smartCollections: SmartCollection[]
  /** Spawn recipes for agent sessions. */
  agentProfiles: AgentProfile[]
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
  /** Optional third dictation chord: speak straight to the primary agent. Empty = unbound. */
  dictateAgentChord?: string
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
  'agents:profiles': () => AgentProfile[]
  'agents:sessions': (includeEnded?: boolean) => AgentSession[]
  'agents:launch': (opts: { profile: string; prompt?: string; title?: string }) => string
  'agents:send': (key: string, text: string, kind?: string) => boolean
  'agents:messages': (key: string) => AgentMessage[]
  'agents:inbox': () => AgentMessage[]
  'agents:mark-read': (key?: string) => void
  'agents:end': (key: string) => void
  /** Ask a defined agent (default: the primary). Ensures its singleton session
   *  exists; delivery retries in the background, so this returns immediately.
   *  itemId attaches a clip: its content + enrichment ride along as context. */
  'agents:ask': (text: string, agent?: string, itemId?: number) => { key: string }
  /** The agent's current session key without launching one (null = none yet). */
  'agents:session-for': (agent?: string) => string | null
  /** Send a clip's content into a running session (formats text/image consistently). */
  'agents:send-clip': (key: string, itemId: number) => boolean
  /** Start a new session whose opening prompt is the clip's content. */
  'agents:launch-with-clip': (opts: { profile: string; itemId: number }) => string
  /** End an agent's singleton session so the next ask relaunches it with fresh
   *  identity/memory (default: the primary). */
  'agents:restart-assistant': (agent?: string) => void
  /** An agent's long-term memory file (markdown); default = the primary's. */
  'assistant:memory-get': (agent?: string) => string
  'assistant:memory-set': (text: string, agent?: string) => void
  /** Distill recent conversations/notes into the memory file now. */
  'assistant:consolidate': (agent?: string) => { ok: boolean; changed: boolean; error?: string }
  /** Draft an identity from what the app already knows (memory, notes, usage). */
  'assistant:generate-identity': (agent?: string) => { ok: boolean; text?: string; error?: string }
  'notes:list': (opts: { q?: string }) => NoteSummary[]
  'notes:get': (id: number) => Note | null
  'notes:create': (input?: { title?: string; content?: string }) => number
  'notes:update': (id: number, patch: { title?: string; content?: string }) => void
  'notes:delete': (id: number) => void
  'notes:backlinks': (id: number) => NoteSummary[]
  'notes:outgoing': (id: number) => Array<{ title: string; toId: number | null }>
  /** Resolve a [[wikilink]] by title, creating the note when it doesn't exist yet. */
  'notes:open-by-title': (title: string) => number
  'notes:daily': () => number
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
  }) => {
    ok: boolean
    text?: string
    error?: string
    pasted?: boolean
    id?: number
    /** Agent the transcript was delivered to, when dictated with the agent chord. */
    sentTo?: string
  }
  /** Retry transcription of a stored dictation recording. */
  'dictation:retry': (itemId: number) => { ok: boolean; text?: string; error?: string }
  /** Save scratchpad text as a clip (new, or as a derived edit of itemId). */
  'scratch:save': (payload: { text: string; itemId?: number }) => number
  /** Write the whole history to a JSON file the user picks. Secrets are excluded. */
  'data:export': () => { ok: boolean; path?: string; count?: number; error?: string }
  'window:hide': () => void
  /** Dictation HUD tells main it finished (transcript delivered or aborted). */
  'dictation:done': () => void
  'agents:defs': () => AgentDef[]
  'window:open-settings': () => void
  'window:open-scratchpad': (itemId?: number) => void
  'window:open-notes': (noteId?: number) => void
  'window:open-agents': () => void
  'app:version': () => string
}

/** IPC events: main -> renderer (send). */
export interface IpcEventMap {
  'items:changed': { reason: 'captured' | 'enriched' | 'deleted' | 'transformed' }
  'palette:shown': { collection?: string; mode?: 'normal' | 'rewrite'; rewriteText?: string }
  'scratchpad:shown': { itemId?: number }
  /** A note was created, edited or deleted — lists elsewhere should re-read. */
  'notes:changed': { id: number }
  /** An agent said something, or a session's state changed. */
  'agents:changed': { unread: number }
  /** Ask the notes window to open a specific note (menu bar, daily note, links). */
  'notes:open': { id?: number }
  'dictation:start': Record<string, never>
  'dictation:stop': Record<string, never>
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
  ignoreApps: ['1password', 'keepassxc', 'bitwarden', 'gnome-keyring'],
  secretAutoClear: false,
  retentionDays: 365,
  maxItems: 50000,
  enrichment: { enabled: true, lane: 'subscription', provider: 'claude-agent' },
  // OpenAI for interactive transforms: a direct API call is snappier than the Agent
  // SDK for a one-shot. It falls back to the subscription lane when no API key is
  // configured (see complete()), so a subscription-only user isn't left with dead
  // transforms.
  transforms: { provider: 'openai' },
  embeddings: { enabled: true },
  // Local Parakeet by default: fully offline, no audio ever leaves the machine, free.
  // First dictation downloads the ~490MB model once; switch to OpenAI in Settings to
  // skip the download at the cost of sending audio to their API.
  transcription: { provider: 'local' },
  linkEnrichment: true,
  sessionsEnabled: true,
  // Fast-by-default: haiku on the Claude lane, Luna on OpenAI, flash-lite on Gemini.
  models: { 'claude-agent': 'haiku', openai: 'gpt-5.6-luna', gemini: 'gemini-flash-lite-latest' },
  dictation: { autoPaste: true, keepAudio: true },
  voiceSamples: [],
  agents: [
    {
      name: 'personal',
      cwd: '',
      description: 'General personal assistant: questions, quick tasks, anything not code-specific.',
      memory: 'own',
      persistent: true,
      prewarm: true,
      tmux: true
    }
    // Add project agents in Settings → Agents, each pointed at its own working
    // directory. (Shipping no personal paths here keeps the default portable.)
  ],
  assistant: { identity: '', identityFiles: [], prewarm: true },
  smartPaste: true,
  // Nano Banana 2 Lite: ~3s round-trip on a real edit, cheapest of the family.
  imageEdit: { provider: 'gemini' },
  savedActions: [],
  smartCollections: [],
  agentProfiles: [
    // cwd '' means the home directory. (Legacy field; `agents` above is canonical.)
    { name: 'personal', cwd: '', tmux: true }
  ],
  hotkeyHint: 'Ctrl+Alt+V',
  dictateChord: DEFAULT_DICTATE_CHORD,
  dictateEnhanceChord: '',
  dictateAgentChord: '',
  theme: 'system',
  pasteInjection: 'portal'
}
