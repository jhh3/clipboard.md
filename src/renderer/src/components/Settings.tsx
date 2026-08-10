import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type {
  AgentDef,
  AppSettings,
  ProviderId,
  ProviderLane,
  ProviderStatus,
  SavedAction
} from '@shared/types'
import { invoke, on } from '../lib/ipc'
import { IS_MAC, GLOBAL_MOD } from '../lib/keys'
import { DEFAULT_DICTATE_CHORD, chordWarning, formatChord, parseChord } from '@shared/chord'
import { useTheme } from '../hooks/useTheme'
import { useToasts } from '../hooks/useToasts'
import DragStrip from './DragStrip'
import Toasts from './Toasts'
import { PlusIcon, SparkIcon, TrashIcon } from './icons'

const PROVIDERS: Array<{ id: ProviderId; label: string }> = [
  { id: 'claude-agent', label: 'Claude (agent)' },
  { id: 'codex', label: 'Codex' },
  { id: 'openai', label: 'OpenAI' },
  { id: 'gemini', label: 'Gemini' }
]

/** Placeholder = the default model used when no override is set. */
const MODEL_PLACEHOLDERS: Record<ProviderId, string> = {
  'claude-agent': 'haiku',
  codex: '(codex default)',
  openai: 'gpt-5.6-luna',
  gemini: 'gemini-flash-lite-latest'
}

/**
 * Known model choices per provider, so picking one is a dropdown instead of
 * remembering a model id. "Custom…" reveals a text field — the lists will age,
 * and a stale list must never block a new model id.
 */
const MODEL_CHOICES: Record<ProviderId, string[]> = {
  'claude-agent': ['haiku', 'sonnet', 'opus'],
  codex: [],
  openai: ['gpt-5.6-luna', 'gpt-5.6', 'gpt-5.1', 'gpt-5'],
  gemini: ['gemini-flash-lite-latest', 'gemini-flash-latest', 'gemini-pro-latest']
}

const CUSTOM = '__custom__'

/** Dropdown of known models with a custom escape hatch. Empty = provider default. */
function ModelSelect({
  provider,
  value,
  onCommit
}: {
  provider: ProviderId
  value: string
  onCommit: (v: string) => void
}) {
  const choices = MODEL_CHOICES[provider]
  const isKnown = value === '' || choices.includes(value)
  const [custom, setCustom] = useState(!isKnown)
  if (choices.length === 0 || custom || !isKnown) {
    return (
      <div className="model-custom">
        <TextField
          value={value}
          placeholder={MODEL_PLACEHOLDERS[provider]}
          onCommit={onCommit}
        />
        {choices.length > 0 && (
          <button
            className="linkish"
            onClick={() => {
              setCustom(false)
              if (!choices.includes(value)) onCommit('')
            }}
          >
            list
          </button>
        )}
      </div>
    )
  }
  return (
    <select
      className="set-input"
      value={value}
      onChange={(e) => {
        if (e.target.value === CUSTOM) setCustom(true)
        else onCommit(e.target.value)
      }}
    >
      <option value="">Default ({MODEL_PLACEHOLDERS[provider]})</option>
      {choices.map((m) => (
        <option key={m} value={m}>
          {m}
        </option>
      ))}
      <option value={CUSTOM}>Custom…</option>
    </select>
  )
}

const SECTIONS = [
  ['general', 'General'],
  ['providers', 'AI Providers'],
  ['intelligence', 'Intelligence'],
  ['assistant', 'Agents'],
  ['privacy', 'Privacy'],
  ['voice', 'Voice'],
  ['actions', 'Actions']
] as const

type SectionId = (typeof SECTIONS)[number][0]

/** Long file paths read better with the middle elided — head and tail carry the meaning. */
function truncateMiddle(text: string, max = 54): string {
  if (text.length <= max) return text
  const head = Math.ceil((max - 1) / 2)
  const tail = max - 1 - head
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`
}

/**
 * External settings updates (the 'settings:changed' broadcast) must not yank a
 * field out from under the user, so draft inputs only re-sync while unfocused.
 */
function useSyncedDraft<T>(
  value: T,
  el: { current: HTMLElement | null }
): [T, (v: T) => void] {
  const [draft, setDraft] = useState(value)
  useEffect(() => {
    if (el.current && document.activeElement === el.current) return
    setDraft(value)
    // `el` is a stable ref — value is the only real dependency.
  }, [value, el])
  return [draft, setDraft]
}

// ── small building blocks ────────────────────────────────────────────────────

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className={'toggle' + (checked ? ' on' : '')}
      onClick={() => onChange(!checked)}
    >
      <span className="toggle-knob" />
    </button>
  )
}

function Row({
  label,
  sub,
  children
}: {
  label: string
  sub?: string
  children: ReactNode
}) {
  return (
    <div className="set-row">
      <div className="set-row-text">
        <div className="set-label">{label}</div>
        {sub && <div className="set-sub">{sub}</div>}
      </div>
      <div className="set-control">{children}</div>
    </div>
  )
}

/**
 * Dictation dictionary editor. Commits on blur rather than per keystroke: this writes
 * the settings file, and the main process re-reads it on change.
 */
function DictionaryField({
  value,
  onCommit
}: {
  value: string
  onCommit: (v: string) => void
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null)
  const [draft, setDraft] = useSyncedDraft(value, ref)
  return (
    <textarea
      ref={ref}
      className="set-textarea identity-textarea"
      spellCheck={false}
      placeholder={'clipboard dot md => clipboard.md\nParakeet\nsherpa => sherpa-onnx'}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== value) onCommit(draft)
      }}
    />
  )
}

function NumberField({
  value,
  min,
  max,
  onCommit
}: {
  value: number
  min: number
  max: number
  onCommit: (n: number) => void
}) {
  const ref = useRef<HTMLInputElement | null>(null)
  const [draft, setDraft] = useSyncedDraft(String(value), ref)
  const commit = () => {
    const n = Number(draft)
    if (Number.isFinite(n)) onCommit(Math.min(max, Math.max(min, Math.round(n))))
    else setDraft(String(value))
  }
  return (
    <input
      ref={ref}
      className="set-input num"
      value={draft}
      inputMode="numeric"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
      }}
    />
  )
}

/** Draft-then-commit text input: persists on blur / Enter, not per keystroke. */
function TextField({
  value,
  placeholder,
  password,
  onCommit
}: {
  value: string
  placeholder?: string
  password?: boolean
  onCommit: (v: string) => void
}) {
  const ref = useRef<HTMLInputElement | null>(null)
  const [draft, setDraft] = useSyncedDraft(value, ref)
  return (
    <input
      ref={ref}
      className="set-input text-field"
      type={password ? 'password' : 'text'}
      value={draft}
      placeholder={placeholder}
      spellCheck={false}
      autoComplete="off"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft.trim() !== value) onCommit(draft.trim())
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
      }}
    />
  )
}

/**
 * Capture a keyboard chord by pressing it.
 *
 * Typing a chord as text is how you get "Ctrl+Alt+Spacebar" stored and silently
 * unmatched, so the field records a real key event instead. `e.code` is the physical
 * key and is layout-independent, which matters here: evdev reports raw keycodes too,
 * so recording by code is what keeps the two ends describing the same physical key.
 *
 * Rejected chords are shown as rejected rather than swallowed — a chord evdev cannot
 * observe would look bound and never fire.
 */
function ChordField({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [recording, setRecording] = useState(false)
  /**
   * Derived from the stored value, not remembered from the last capture, so the
   * caution is still there when Settings is reopened. A warning that only appears in
   * the moment is one the user has already dismissed by the time it matters.
   */
  const parsed = parseChord(value)
  const note = parsed ? chordWarning(parsed) : null

  /**
   * Browser key code → our canonical key name.
   *
   * e.code is the PHYSICAL key and is layout-independent, which is what makes it
   * comparable with the raw evdev codes the hold is watched on. Numpad*, F13–F24 and
   * the navigation keys are listed because that is what a programmable keypad emits —
   * they are the whole reason single-key binding exists.
   */
  const codeToKey = (code: string): string | null => {
    if (code === 'Space') return 'Space'
    if (/^Key[A-Z]$/.test(code)) return code.slice(3)
    if (/^Digit\d$/.test(code)) return code.slice(5)
    if (/^F([1-9]|1\d|2[0-4])$/.test(code)) return code
    if (/^Numpad(\d|Add|Subtract|Multiply|Divide|Decimal|Enter)$/.test(code)) return code
    if (['Insert', 'Delete', 'Home', 'End', 'PageUp', 'PageDown', 'Pause', 'ScrollLock'].includes(code))
      return code
    if (code === 'ContextMenu') return 'Menu'
    return null
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>): void => {
    e.preventDefault()
    e.stopPropagation()
    if (e.key === 'Escape') {
      setRecording(false)
      return
    }
    const key = codeToKey(e.code)
    if (!key) return // a lone modifier, or a key we cannot express: keep waiting
    const parts: string[] = []
    if (e.ctrlKey) parts.push('Ctrl')
    if (e.altKey) parts.push('Alt')
    if (e.shiftKey) parts.push('Shift')
    if (e.metaKey) parts.push('Super')
    parts.push(key)
    const chord = parseChord(parts.join('+'))
    if (!chord) return
    setRecording(false)
    onCommit(formatChord(chord))
  }

  const isDefault = value === DEFAULT_DICTATE_CHORD
  return (
    <div className="chord-field">
      <div className="chord-row">
        <button
          type="button"
          className={'set-input chord-capture' + (recording ? ' recording' : '')}
          onClick={() => setRecording(true)}
          /*
           * No onBlur cancel. Pressing a chord that is ALREADY a global binding fires
           * that action too — the dictation HUD appears and takes focus — and a blur
           * handler would cancel the capture before the keydown committed it, so
           * rebinding away from the current chord could never work.
           */
          onKeyDown={recording ? onKeyDown : undefined}
        >
          {recording ? 'Press a key…' : value || DEFAULT_DICTATE_CHORD}
        </button>
        {!isDefault && (
          <button
            type="button"
            className="linkish"
            onClick={() => {
              setRecording(false)
              onCommit(DEFAULT_DICTATE_CHORD)
            }}
          >
            Reset
          </button>
        )}
      </div>
      {note && <span className="set-sub chord-warn">{note}</span>}
    </div>
  )
}

function ProviderSelect({
  value,
  onChange
}: {
  value: ProviderId
  onChange: (p: ProviderId) => void
}) {
  return (
    <select
      className="set-input"
      value={value}
      onChange={(e) => onChange(e.target.value as ProviderId)}
    >
      {PROVIDERS.map((p) => (
        <option key={p.id} value={p.id}>
          {p.label}
        </option>
      ))}
    </select>
  )
}

/** Sentinel value for the "saved but not connected" placeholder option. */
const MIC_MISSING = '__mic-missing__'

/**
 * Microphone picker for dictation.
 *
 * Device *labels* are only exposed once mic permission has been granted at
 * least once, so before a first dictation the list is real but anonymous — we
 * still show it, numbered, with a note explaining why.
 */
function MicSelect({
  deviceId,
  deviceLabel,
  onChange
}: {
  deviceId?: string
  deviceLabel?: string
  /** Empty id = system default (clears both saved fields). */
  onChange: (deviceId: string, deviceLabel: string) => void
}) {
  const [mics, setMics] = useState<MediaDeviceInfo[]>([])
  const [enumerated, setEnumerated] = useState(false)

  useEffect(() => {
    const md = navigator.mediaDevices
    if (!md?.enumerateDevices) {
      setEnumerated(true)
      return
    }
    let alive = true
    const refresh = () => {
      md.enumerateDevices()
        .then((list) => {
          if (!alive) return
          setMics(list.filter((d) => d.kind === 'audioinput'))
          setEnumerated(true)
        })
        .catch(() => {
          if (alive) setEnumerated(true)
        })
    }
    refresh()
    // Keeps the list honest while Settings is open (mic plugged/unplugged).
    md.addEventListener('devicechange', refresh)
    return () => {
      alive = false
      md.removeEventListener('devicechange', refresh)
    }
  }, [])

  const saved = deviceId ?? ''
  const missing = saved !== '' && enumerated && !mics.some((d) => d.deviceId === saved)
  const anonymous = mics.length > 0 && mics.every((d) => !d.label)

  return (
    <div className="mic-select">
      <select
        className="set-input"
        value={missing ? MIC_MISSING : saved}
        onChange={(e) => {
          const id = e.target.value
          if (id === MIC_MISSING) return
          onChange(id, mics.find((d) => d.deviceId === id)?.label ?? '')
        }}
      >
        <option value="">System default</option>
        {mics.map((d, i) => (
          <option key={d.deviceId || i} value={d.deviceId}>
            {d.label || `Microphone ${i + 1}`}
          </option>
        ))}
        {missing && (
          <option value={MIC_MISSING} disabled>
            {`${deviceLabel ?? 'Saved device'} (not connected)`}
          </option>
        )}
      </select>
      {missing && <div className="set-note warn">Falling back to the system default</div>}
      {anonymous && !missing && (
        <div className="set-note">
          Grant microphone access once (start a dictation) to see device names
        </div>
      )}
    </div>
  )
}

/** Identity textarea: draft-then-commit like every other text control here. */
function IdentityEditor({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const ref = useRef<HTMLTextAreaElement | null>(null)
  const [draft, setDraft] = useSyncedDraft(value, ref)
  return (
    <textarea
      ref={ref}
      className="set-textarea identity-textarea"
      value={draft}
      placeholder={
        'Who you are and how the assistant should help.\n' +
        'e.g. "I\'m John, a software engineer. Prefer terse answers. My projects live in ~/Documents/code."'
      }
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== value) onCommit(draft)
      }}
    />
  )
}

/**
 * One agent definition. The first card is the PRIMARY — the palette's default
 * ask target and the owner of the main memory file — so it can't be deleted.
 */
function AgentCard({
  def,
  isPrimary,
  drafting,
  restarting,
  onPatch,
  onDraft,
  onRestart,
  onRemove
}: {
  def: AgentDef
  isPrimary: boolean
  drafting: boolean
  restarting: boolean
  onPatch: (changes: Partial<AgentDef>) => void
  onDraft: () => void
  onRestart: () => void
  onRemove: () => void
}) {
  const [newFile, setNewFile] = useState('')
  const addFile = (): void => {
    const path = newFile.trim()
    const files = def.identityFiles ?? []
    if (!path || files.includes(path)) return
    onPatch({ identityFiles: [...files, path] })
    setNewFile('')
  }
  return (
    <div className="agent-card">
      <div className="agent-card-head">
        <span className="agent-card-name">@{def.name}</span>
        {isPrimary ? (
          <span className="agent-primary-badge">primary</span>
        ) : (
          <button className="icon-btn" title="Remove agent" onClick={onRemove}>
            <TrashIcon size={13} />
          </button>
        )}
      </div>
      <label className="agent-field">
        <span>Description</span>
        <TextField
          value={def.description ?? ''}
          placeholder="What this agent is for — write it like routing rules"
          onCommit={(v) => onPatch({ description: v || undefined })}
        />
      </label>
      <label className="agent-field">
        <span>Working directory</span>
        <TextField
          value={def.cwd}
          placeholder="(home directory)"
          onCommit={(v) => onPatch({ cwd: v })}
        />
      </label>
      <div className="agent-field">
        <span>Identity</span>
        <IdentityEditor
          value={def.identity ?? ''}
          onCommit={(v) => onPatch({ identity: v || undefined })}
        />
        <div className="set-inline-actions">
          <button className="btn" disabled={drafting} onClick={onDraft}>
            <SparkIcon size={12} /> {drafting ? 'Drafting…' : 'Draft with AI'}
          </button>
        </div>
      </div>
      <div className="agent-field">
        <span>Identity files</span>
        <div className="list-editor">
          {(def.identityFiles ?? []).map((file, i) => (
            <div key={`${file}:${i}`} className="list-item-row">
              <span className="list-item-text mono" title={file}>
                {truncateMiddle(file)}
              </span>
              <button
                className="icon-btn"
                title="Remove"
                onClick={() =>
                  onPatch({ identityFiles: (def.identityFiles ?? []).filter((_, j) => j !== i) })
                }
              >
                <TrashIcon size={13} />
              </button>
            </div>
          ))}
          <div className="list-add-row">
            <input
              className="set-input"
              value={newFile}
              placeholder="/absolute/path/to/identity.md"
              spellCheck={false}
              onChange={(e) => setNewFile(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') addFile()
              }}
            />
            <button className="btn" onClick={addFile}>
              Add
            </button>
          </div>
        </div>
      </div>
      <div className="agent-card-row">
        <label className="agent-inline">
          Memory
          <select
            className="set-input"
            value={def.memory ?? (isPrimary ? 'own' : 'off')}
            onChange={(e) => onPatch({ memory: e.target.value as AgentDef['memory'] })}
          >
            <option value="own">Own file</option>
            <option value="shared">Shared with primary</option>
            <option value="off">Off</option>
          </select>
        </label>
        <label className="agent-inline">
          Ask target
          <Toggle
            checked={def.persistent !== false}
            onChange={(v) => onPatch({ persistent: v })}
          />
        </label>
        <label className="agent-inline">
          Pre-warm
          <Toggle checked={def.prewarm === true} onChange={(v) => onPatch({ prewarm: v })} />
        </label>
        <button className="btn agent-restart" disabled={restarting} onClick={onRestart}>
          {restarting ? 'Restarting…' : 'Restart session'}
        </button>
      </div>
    </div>
  )
}

function VoiceSample({
  value,
  onCommit,
  onRemove
}: {
  value: string
  onCommit: (v: string) => void
  onRemove: () => void
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null)
  const [draft, setDraft] = useSyncedDraft(value, ref)
  return (
    <div className="voice-sample">
      <textarea
        ref={ref}
        className="set-textarea"
        value={draft}
        placeholder="A sample of your writing voice…"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft !== value) onCommit(draft)
        }}
      />
      <button className="icon-btn" title="Remove sample" onClick={onRemove}>
        <TrashIcon size={13} />
      </button>
    </div>
  )
}

function ActionEditor({
  action,
  onSave,
  onDelete
}: {
  action: SavedAction
  onSave: (a: SavedAction) => void
  onDelete: () => void
}) {
  const [draft, setDraft] = useState(action)
  const commit = () => {
    if (JSON.stringify(draft) !== JSON.stringify(action)) onSave(draft)
  }
  const toggleApplies = (k: 'text' | 'image') => {
    const has = draft.appliesTo.includes(k)
    const next: SavedAction = {
      ...draft,
      appliesTo: has ? draft.appliesTo.filter((x) => x !== k) : [...draft.appliesTo, k]
    }
    setDraft(next)
    onSave(next)
  }
  return (
    <div className="action-card">
      <div className="action-card-row">
        <input
          className="set-input title-input"
          value={draft.title}
          placeholder="Action title"
          onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          onBlur={commit}
        />
        <input
          className="set-input key-input"
          value={draft.key ?? ''}
          maxLength={1}
          placeholder="key"
          title="Single-key binding inside Action Mode"
          onChange={(e) => setDraft({ ...draft, key: e.target.value || undefined })}
          onBlur={commit}
        />
        {draft.type === 'prompt' ? (
          <span className="action-ai">AI</span>
        ) : (
          <span className="builtin-badge">{draft.builtinId ?? 'builtin'}</span>
        )}
        <button className="icon-btn" title="Delete action" onClick={onDelete}>
          <TrashIcon size={13} />
        </button>
      </div>
      {draft.type === 'prompt' && (
        <textarea
          className="set-textarea"
          value={draft.prompt ?? ''}
          placeholder="Prompt — the clip content is provided as input"
          onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
          onBlur={commit}
        />
      )}
      <div className="applies-group">
        <span>Applies to</span>
        {(['text', 'image'] as const).map((k) => (
          <label key={k}>
            <input
              type="checkbox"
              checked={draft.appliesTo.includes(k)}
              onChange={() => toggleApplies(k)}
            />{' '}
            {k}
          </label>
        ))}
        <label className="action-provider">
          Provider
          <select
            className="set-input"
            value={draft.provider ?? ''}
            title="Provider override for this action — blank uses the default transforms provider"
            onChange={(e) => {
              const v = e.target.value
              const next: SavedAction = {
                ...draft,
                provider: v === '' ? undefined : (v as ProviderId)
              }
              setDraft(next)
              onSave(next)
            }}
          >
            <option value="">Default</option>
            {PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  )
}

// ── settings window ──────────────────────────────────────────────────────────

export default function Settings() {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [providers, setProviders] = useState<ProviderStatus[]>([])
  const [savedActions, setSavedActions] = useState<SavedAction[]>([])
  const [section, setSection] = useState<SectionId>('general')
  const [savedFlash, setSavedFlash] = useState(false)
  const [newApp, setNewApp] = useState('')
  const [exporting, setExporting] = useState(false)
  const [exportNote, setExportNote] = useState<{ ok: boolean; text: string; title?: string } | null>(
    null
  )
  const { toasts, addToast } = useToasts()
  const theme = useTheme(settings?.theme)
  const flashTimer = useRef(0)
  const actionsInit = useRef(false)
  const [newIdentityFile, setNewIdentityFile] = useState('')
  const [restarting, setRestarting] = useState<string | null>(null)
  const [memory, setMemory] = useState<string | null>(null)
  /** Which agent's memory file the viewer shows; undefined = the primary. */
  const [memAgent, setMemAgent] = useState<string | undefined>(undefined)
  const memAgentRef = useRef<string | undefined>(undefined)
  memAgentRef.current = memAgent
  const [consolidating, setConsolidating] = useState(false)
  const memoryRef = useRef<HTMLTextAreaElement | null>(null)
  /** What the file held when we last loaded it — writes only happen on a real
   *  edit. An unconditional blur-save clobbered facts the assistant remembered
   *  after Settings loaded its snapshot. */
  const memoryLoadedRef = useRef<string | null>(null)

  const loadMemory = useCallback(async () => {
    try {
      const text = await invoke('assistant:memory-get', memAgentRef.current)
      memoryLoadedRef.current = text
      setMemory(text)
    } catch {
      setMemory('')
    }
  }, [])

  useEffect(() => {
    void loadMemory()
  }, [loadMemory, memAgent])

  useEffect(() => {
    // The file changes underneath us (remember tool, consolidation) — re-read
    // whenever the window comes back, unless the user is mid-edit.
    const onVis = (): void => {
      if (document.hidden) return
      if (document.activeElement === memoryRef.current) return
      void loadMemory()
    }
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('focus', onVis)
    return () => {
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('focus', onVis)
    }
  }, [loadMemory])

  const flashSaved = useCallback(() => {
    setSavedFlash(true)
    window.clearTimeout(flashTimer.current)
    flashTimer.current = window.setTimeout(() => setSavedFlash(false), 1200)
  }, [])

  const saveMemory = useCallback(
    (text: string) => {
      // No edit, no write: the loaded snapshot may be stale against what the
      // assistant remembered since, and writing it back would erase that.
      if (text === memoryLoadedRef.current) return
      setMemory(text)
      memoryLoadedRef.current = text
      invoke('assistant:memory-set', text, memAgentRef.current)
        .then(flashSaved)
        .catch(() => addToast('Failed to save memory', 'error'))
    },
    [addToast, flashSaved]
  )

  const consolidateNow = useCallback(async () => {
    setConsolidating(true)
    try {
      const res = await invoke('assistant:consolidate', memAgentRef.current)
      if (!res.ok) addToast(res.error ?? 'Consolidation failed', 'error')
      else addToast(res.changed ? 'Memory consolidated' : 'Nothing new to fold in', 'success')
      await loadMemory()
    } catch {
      addToast('Consolidation failed', 'error')
    } finally {
      setConsolidating(false)
    }
  }, [addToast, loadMemory])

  /** Which agent card has a draft in flight (name), if any. */
  const [drafting, setDrafting] = useState<string | null>(null)

  /** Update one agent definition by name — always against the freshest settings,
   *  since identity drafts take seconds. */
  const patchAgent = useCallback(
    async (name: string, changes: Partial<AgentDef>) => {
      const cur = await invoke('settings:get')
      const next = await invoke('settings:set', {
        agents: cur.agents.map((a) => (a.name === name ? { ...a, ...changes } : a))
      })
      setSettings(next)
      flashSaved()
    },
    [flashSaved]
  )

  /** Draft an identity from what the app already knows; lands in settings
   *  immediately (still fully editable) so the flow is one click, not two. */
  const draftIdentity = useCallback(
    async (agentName: string) => {
      setDrafting(agentName)
      try {
        const res = await invoke('assistant:generate-identity', agentName)
        if (res.ok && res.text) {
          await patchAgent(agentName, { identity: res.text })
          addToast('Draft written from your notes, memory and usage — edit away', 'success')
        } else {
          addToast(res.error ?? 'Could not draft an identity', 'error')
        }
      } catch {
        addToast('Could not draft an identity', 'error')
      } finally {
        setDrafting(null)
      }
    },
    [addToast, patchAgent]
  )

  const restartAgent = useCallback(
    async (agentName: string) => {
      setRestarting(agentName)
      try {
        await invoke('agents:restart-assistant', agentName)
        addToast(`${agentName} will relaunch with fresh identity on the next ask`, 'success')
      } catch {
        addToast('Could not restart the agent', 'error')
      } finally {
        setRestarting(null)
      }
    },
    [addToast]
  )

  useEffect(() => {
    invoke('settings:get')
      .then(setSettings)
      .catch(() => addToast('Failed to load settings', 'error'))
    invoke('providers:status')
      .then(setProviders)
      .catch(() => {})
  }, [addToast])

  // Settings can change from other windows (or main itself) — adopt the
  // broadcast wholesale. Focused draft inputs keep their draft (useSyncedDraft).
  useEffect(() => on('settings:changed', (p) => setSettings(p.settings)), [])

  // Saved actions get their own local list (persisted via actions:save/:delete,
  // not settings:set) — seed it once from the loaded settings.
  useEffect(() => {
    if (settings && !actionsInit.current) {
      actionsInit.current = true
      setSavedActions(settings.savedActions)
    }
  }, [settings])

  /** Optimistic patch: apply locally, persist, then adopt the authoritative result. */
  const patch = useCallback(
    (p: Partial<AppSettings>) => {
      setSettings((s) => (s ? { ...s, ...p } : s))
      invoke('settings:set', p)
        .then((next) => {
          setSettings(next)
          flashSaved()
        })
        .catch(() => addToast('Failed to save settings', 'error'))
    },
    [addToast, flashSaved]
  )

  const saveAction = useCallback(
    (a: SavedAction) => {
      setSavedActions((list) => list.map((x) => (x.id === a.id ? a : x)))
      invoke('actions:save', a)
        .then(flashSaved)
        .catch(() => addToast('Failed to save action', 'error'))
    },
    [addToast, flashSaved]
  )

  const addAction = useCallback(() => {
    const a: SavedAction = {
      id: crypto.randomUUID(),
      title: 'New AI action',
      type: 'prompt',
      prompt: '',
      appliesTo: ['text']
    }
    setSavedActions((list) => [...list, a])
    invoke('actions:save', a)
      .then(flashSaved)
      .catch(() => addToast('Failed to save action', 'error'))
  }, [addToast, flashSaved])

  /** Native save dialog lives in main; a user-cancelled dialog reports nothing. */
  const exportHistory = useCallback(async () => {
    setExporting(true)
    setExportNote(null)
    try {
      const res = await invoke('data:export')
      if (res.ok) {
        const n = res.count ?? 0
        const path = res.path ?? ''
        setExportNote({
          ok: true,
          text: `Exported ${n.toLocaleString()} item${n === 1 ? '' : 's'} to ${truncateMiddle(path)}`,
          title: path
        })
      } else if ((res.error ?? '').toLowerCase() !== 'cancelled') {
        setExportNote({ ok: false, text: res.error ?? 'Export failed' })
      }
    } catch {
      setExportNote({ ok: false, text: 'Export failed' })
    } finally {
      setExporting(false)
    }
  }, [])

  const deleteAction = useCallback(
    (id: string) => {
      setSavedActions((list) => list.filter((x) => x.id !== id))
      invoke('actions:delete', id)
        .then(flashSaved)
        .catch(() => addToast('Failed to delete action', 'error'))
    },
    [addToast, flashSaved]
  )

  if (!settings) {
    return (
      <div className="appwin" data-theme={theme}>
        <DragStrip title="Settings" />
        <div className="appwin-loading">Loading settings…</div>
      </div>
    )
  }
  const s = settings

  const addIgnoreApp = () => {
    const app = newApp.trim().toLowerCase()
    if (!app || s.ignoreApps.includes(app)) return
    patch({ ignoreApps: [...s.ignoreApps, app] })
    setNewApp('')
  }

  return (
    <div className="appwin settings-win" data-theme={theme}>
      <DragStrip
        title="Settings"
        tools={<span className={'saved-flash' + (savedFlash ? ' show' : '')}>Saved</span>}
      />
      <div className="settings-body">
        <nav className="settings-nav">
          {SECTIONS.map(([id, label]) => (
            <button
              key={id}
              className={section === id ? 'active' : ''}
              onClick={() => setSection(id)}
            >
              {label}
            </button>
          ))}
        </nav>
        <main className="settings-main">
          {section === 'general' && (
            <>
              <h2 className="set-section-title">General</h2>
              <p className="set-section-sub">Capture behavior, history limits, and appearance.</p>
              <Row label="Capture clipboard" sub="Watch the clipboard and store new copies.">
                <Toggle
                  checked={s.captureEnabled}
                  onChange={(v) => patch({ captureEnabled: v })}
                />
              </Row>
              <Row label="Poll interval" sub="How often the clipboard is checked, in milliseconds.">
                <NumberField
                  value={s.pollIntervalMs}
                  min={100}
                  max={5000}
                  onCommit={(n) => patch({ pollIntervalMs: n })}
                />
                <span className="set-unit">ms</span>
              </Row>
              <Row label="Retention" sub="Unpinned items older than this are pruned.">
                <NumberField
                  value={s.retentionDays}
                  min={1}
                  max={3650}
                  onCommit={(n) => patch({ retentionDays: n })}
                />
                <span className="set-unit">days</span>
              </Row>
              <Row label="Max items" sub="Hard cap on stored history size.">
                <NumberField
                  value={s.maxItems}
                  min={100}
                  max={1000000}
                  onCommit={(n) => patch({ maxItems: n })}
                />
              </Row>
              {/*
                macOS only, and hidden rather than disabled elsewhere. The shaping in
                paste.ts is gated on `process.platform === 'darwin'` because it needs
                the frontmost app at paste time, which the helper supplies and Linux
                has no equivalent for yet — the palette is focused by then, so xprop
                would name us. A toggle that changes nothing is worse than no toggle.
              */}
              {IS_MAC && (
                <Row
                  label="Smart paste"
                  sub="Adapt pastes to the destination app: plain text into terminals, code clips fenced into Slack/Discord."
                >
                  <Toggle
                    checked={s.smartPaste !== false}
                    onChange={(v) => patch({ smartPaste: v })}
                  />
                </Row>
              )}
              <Row label="Theme">
                <select
                  className="set-input"
                  value={s.theme}
                  onChange={(e) => patch({ theme: e.target.value as AppSettings['theme'] })}
                >
                  <option value="system">System</option>
                  <option value="dark">Dark</option>
                  <option value="light">Light</option>
                </select>
              </Row>
              <Row
                label="Global hotkeys"
                sub={
                  IS_MAC
                    ? 'Registered at launch: ⌘⇧V palette · R rewrite · S screenshot · E scratchpad · N notes · A inbox. Dictation: hold 🌐 (Fn) to talk, or ⌘⇧D to toggle. If 🌐 also triggers a system action, set Keyboard → "Press 🌐 key to" → Do Nothing.'
                    : 'Registered as GNOME custom keybindings — edit them in system Settings → Keyboard → Custom Shortcuts.'
                }
              >
                <kbd className="hotkey-kbd">{IS_MAC ? `${GLOBAL_MOD}V` : s.hotkeyHint}</kbd>
              </Row>
              {/*
                Linux only. The chord drives both the GNOME keybinding that starts
                dictation and the evdev codes that watch the hold, so it has to be one
                setting — see shared/chord.ts. macOS dictation is the Fn/🌐 key via the
                helper's event tap and is deliberately not configurable here.
              */}
              {!IS_MAC && (
                <Row
                  label="Hold-to-talk chord"
                  sub="Hold this to dictate; release to transcribe. A single key works — ideal for a macro pad."
                >
                  <ChordField
                    value={s.dictateChord}
                    onCommit={(v) => patch({ dictateChord: v })}
                  />
                </Row>
              )}
            </>
          )}

          {section === 'providers' && (
            <>
              <h2 className="set-section-title">AI Providers</h2>
              <p className="set-section-sub">
                Subscription lane uses your Claude / Codex plans via their local agents. API lane
                calls OpenAI or Gemini directly with OPENAI_API_KEY / GEMINI_API_KEY from your
                environment.
              </p>
              <Row
                label="Enrichment lane"
                sub="Subscription = the claude/codex CLIs already signed in on this machine. API = direct calls with your own keys."
              >
                <select
                  className="set-input"
                  value={s.enrichment.lane}
                  onChange={(e) => {
                    const lane = e.target.value as ProviderLane
                    // Keep the provider inside the chosen lane — a subscription
                    // lane pointed at OpenAI silently does nothing.
                    const first = lane === 'subscription' ? 'claude-agent' : 'openai'
                    const stillValid =
                      lane === 'subscription'
                        ? ['claude-agent', 'codex'].includes(s.enrichment.provider)
                        : ['openai', 'gemini'].includes(s.enrichment.provider)
                    patch({
                      enrichment: {
                        ...s.enrichment,
                        lane,
                        provider: stillValid ? s.enrichment.provider : (first as ProviderId)
                      }
                    })
                  }}
                >
                  <option value="subscription">Subscription (claude / codex CLI)</option>
                  <option value="api">API key (OpenAI / Gemini)</option>
                </select>
              </Row>
              <Row label="Enrichment provider" sub="Only providers in the chosen lane are offered.">
                {(() => {
                  const laneIds =
                    s.enrichment.lane === 'subscription'
                      ? ['claude-agent', 'codex']
                      : ['openai', 'gemini']
                  // A stored value OUTSIDE the lane (saved by the old unrestricted
                  // UI) must stay visible — hiding it made the select claim a
                  // working provider while enrichment silently ran on the broken
                  // one and produced nothing.
                  const stray = !laneIds.includes(s.enrichment.provider)
                  return (
                    <div className="set-stack">
                      <select
                        className="set-input"
                        value={s.enrichment.provider}
                        onChange={(e) =>
                          patch({
                            enrichment: { ...s.enrichment, provider: e.target.value as ProviderId }
                          })
                        }
                      >
                        {PROVIDERS.filter((p) => laneIds.includes(p.id)).map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.label}
                          </option>
                        ))}
                        {stray && (
                          <option value={s.enrichment.provider}>
                            {PROVIDERS.find((p) => p.id === s.enrichment.provider)?.label ??
                              s.enrichment.provider}{' '}
                            — not in this lane
                          </option>
                        )}
                      </select>
                      {stray && (
                        <div className="set-note warn">
                          This provider isn&apos;t in the chosen lane, so enrichment produces
                          nothing — pick one of the offered providers (or switch the lane).
                        </div>
                      )}
                    </div>
                  )
                })()}
              </Row>
              <Row
                label="Transforms provider"
                sub="Runs AI actions, free prompts, and rewrites. Lane follows the provider (no separate lane setting yet)."
              >
                <ProviderSelect
                  value={s.transforms.provider}
                  onChange={(p) => patch({ transforms: { provider: p } })}
                />
              </Row>
              <div className="set-block">
                <div className="set-label">Models</div>
                <div className="set-sub">
                  Fast models by default; pick any model your provider supports.
                </div>
                <div className="model-grid">
                  {PROVIDERS.map((p) => (
                    <label key={p.id} className="model-row">
                      <span className="model-provider">{p.label}</span>
                      <ModelSelect
                        provider={p.id}
                        value={s.models[p.id] ?? ''}
                        onCommit={(v) => {
                          const models = { ...s.models }
                          if (v) models[p.id] = v
                          else delete models[p.id]
                          patch({ models })
                        }}
                      />
                    </label>
                  ))}
                </div>
              </div>
              <Row
                label="Image editing"
                sub="Edits image clips from an instruction (palette: e on an image). Nano Banana 2 Lite is ~3s and cheap; GPT Image 2 is slower but stronger."
              >
                <div className="set-stack">
                  <select
                    className="set-input"
                    value={s.imageEdit.provider}
                    onChange={(e) =>
                      patch({
                        imageEdit: { provider: e.target.value as 'gemini' | 'openai', model: '' }
                      })
                    }
                  >
                    <option value="gemini">Gemini (GEMINI_API_KEY)</option>
                    <option value="openai">OpenAI (OPENAI_API_KEY)</option>
                  </select>
                  <select
                    className="set-input"
                    value={s.imageEdit.model ?? ''}
                    onChange={(e) =>
                      patch({ imageEdit: { ...s.imageEdit, model: e.target.value || undefined } })
                    }
                  >
                    {(s.imageEdit.provider === 'gemini'
                      ? [
                          ['', 'Nano Banana 2 Lite (default)'],
                          ['gemini-3.1-flash-image', 'Nano Banana 2'],
                          ['gemini-3-pro-image', 'Nano Banana Pro'],
                          ['gemini-2.5-flash-image', 'Nano Banana (v1)']
                        ]
                      : [
                          ['', 'GPT Image 2 (default)'],
                          ['gpt-image-1.5', 'GPT Image 1.5'],
                          ['gpt-image-1-mini', 'GPT Image 1 mini']
                        ]
                    ).map(([v, label]) => (
                      <option key={v} value={v}>
                        {label}
                      </option>
                    ))}
                  </select>
                </div>
              </Row>
              <div className="set-block">
                <div className="set-label">Provider status</div>
                <div className="provider-list">
                  {providers.length === 0 && (
                    <div className="set-sub">No provider status reported.</div>
                  )}
                  {providers.map((p) => (
                    <div key={`${p.id}:${p.lane}`} className="provider-row">
                      <span className={'dot' + (p.available ? ' ok' : '')} />
                      <span className="provider-name">
                        {PROVIDERS.find((x) => x.id === p.id)?.label ?? p.id}
                      </span>
                      <span className="provider-lane">{p.lane}</span>
                      <span className="provider-detail" title={p.detail}>
                        {p.detail}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}

          {section === 'intelligence' && (
            <>
              <h2 className="set-section-title">Intelligence</h2>
              <p className="set-section-sub">
                What the AI pipeline does with new clips. Secrets are always excluded.
              </p>
              <Row label="Enrichment" sub="Auto-title, tag, and classify new clips.">
                <Toggle
                  checked={s.enrichment.enabled}
                  onChange={(v) => patch({ enrichment: { ...s.enrichment, enabled: v } })}
                />
              </Row>
              <Row label="Embeddings" sub="Semantic (hybrid) search over your history.">
                <Toggle
                  checked={s.embeddings.enabled}
                  onChange={(v) => patch({ embeddings: { enabled: v } })}
                />
              </Row>
              <Row label="Fetch & summarize copied links" sub="Enrich copied URLs with page titles and summaries.">
                <Toggle checked={s.linkEnrichment} onChange={(v) => patch({ linkEnrichment: v })} />
              </Row>
              <Row
                label="Firecrawl API key"
                sub="Upgrades link extraction for JS-heavy pages. Stored locally, never required."
              >
                <TextField
                  password
                  value={s.firecrawlApiKey ?? ''}
                  placeholder="fc-… (optional — better article extraction)"
                  onCommit={(v) => patch({ firecrawlApiKey: v || undefined })}
                />
              </Row>
              <Row label="Sessions" sub="Group bursts of copying into titled work sessions.">
                <Toggle checked={s.sessionsEnabled} onChange={(v) => patch({ sessionsEnabled: v })} />
              </Row>
              <Row
                label="Transcription"
                sub="Speech-to-text engine for dictation and the scratchpad mic."
              >
                <div className="set-stack">
                  <select
                    className="set-input"
                    value={s.transcription.provider}
                    onChange={(e) =>
                      patch({
                        transcription: {
                          provider: e.target.value as AppSettings['transcription']['provider']
                        }
                      })
                    }
                  >
                    <option value="openai">OpenAI</option>
                    <option value="local">Local (Parakeet, offline — ~490MB download)</option>
                  </select>
                  {s.transcription.provider === 'local' && (
                    <div className="set-note">
                      First use downloads a ~490MB model once, then runs fully offline.
                    </div>
                  )}
                </div>
              </Row>
              <Row
                label="Microphone"
                sub="Input device for dictation and the scratchpad mic."
              >
                <MicSelect
                  deviceId={s.dictation.deviceId}
                  deviceLabel={s.dictation.deviceLabel}
                  onChange={(deviceId, deviceLabel) =>
                    patch({
                      dictation: {
                        ...s.dictation,
                        deviceId: deviceId || undefined,
                        deviceLabel: deviceId ? deviceLabel || undefined : undefined
                      }
                    })
                  }
                />
              </Row>
              <Row
                label="Auto-paste dictation"
                sub="Paste dictation into the focused app automatically."
              >
                <Toggle
                  checked={s.dictation.autoPaste}
                  onChange={(v) => patch({ dictation: { ...s.dictation, autoPaste: v } })}
                />
              </Row>
              <Row
                label="Keep dictation audio"
                sub="Keep recordings so transcripts can be retried."
              >
                <Toggle
                  checked={s.dictation.keepAudio}
                  onChange={(v) => patch({ dictation: { ...s.dictation, keepAudio: v } })}
                />
              </Row>
              <Row
                label="Dictation dictionary"
                sub="Fix names and jargon the recogniser gets wrong. One rule per line: heard => written, or a bare word to fix its spelling. Applied offline, after transcription."
              >
                <DictionaryField
                  value={s.dictation.dictionary ?? ''}
                  onCommit={(v) =>
                    patch({ dictation: { ...s.dictation, dictionary: v || undefined } })
                  }
                />
              </Row>
            </>
          )}

          {section === 'assistant' && (
            <>
              <h2 className="set-section-title">Agents</h2>
              <p className="set-section-sub">
                Each agent is a persistent Claude session with its own identity, working
                directory, and (optionally) long-term memory. The first is the primary — the
                palette&apos;s default ask target; ⇧Tab there cycles between the others, and
                @name targets one directly. Identity changes apply on each agent&apos;s next
                (re)start.
              </p>
              {s.agents.map((a, i) => (
                <AgentCard
                  key={a.name}
                  def={a}
                  isPrimary={i === 0}
                  drafting={drafting === a.name}
                  restarting={restarting === a.name}
                  onPatch={(changes) => void patchAgent(a.name, changes)}
                  onDraft={() => void draftIdentity(a.name)}
                  onRestart={() => void restartAgent(a.name)}
                  onRemove={() => {
                    patch({ agents: s.agents.filter((x) => x.name !== a.name) })
                    if (memAgent === a.name) setMemAgent(undefined)
                  }}
                />
              ))}
              <div className="list-add-row">
                <input
                  className="set-input"
                  value={newIdentityFile}
                  placeholder="new agent name (letters/dashes)"
                  spellCheck={false}
                  onChange={(e) => setNewIdentityFile(e.target.value)}
                />
                <button
                  className="btn primary"
                  onClick={() => {
                    const name = newIdentityFile.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-')
                    if (!name || s.agents.some((x) => x.name === name)) return
                    patch({
                      agents: [
                        ...s.agents,
                        { name, cwd: '', persistent: true, memory: 'off' as const, tmux: true }
                      ]
                    })
                    setNewIdentityFile('')
                  }}
                >
                  <PlusIcon size={12} /> Add agent
                </button>
              </div>
              <div className="set-block">
                <div className="set-label">Long-term memory</div>
                <div className="set-sub">
                  What an agent has learned. Facts land as you talk (the `remember` tool); a
                  background pass folds conversations in — merging, deduping, dropping stale
                  entries. Yours to edit or erase.
                </div>
                <select
                  className="set-input"
                  value={memAgent ?? s.agents[0]?.name ?? ''}
                  onChange={(e) =>
                    setMemAgent(e.target.value === s.agents[0]?.name ? undefined : e.target.value)
                  }
                >
                  {s.agents
                    .filter((a, i) => (a.memory ?? (i === 0 ? 'own' : 'off')) !== 'off')
                    .map((a) => (
                      <option key={a.name} value={a.name}>
                        @{a.name}
                        {(a.memory ?? 'own') === 'shared' ? ' (shared with primary)' : ''}
                      </option>
                    ))}
                </select>
                <textarea
                  ref={memoryRef}
                  className="set-textarea identity-textarea"
                  value={memory ?? ''}
                  placeholder={memory === null ? 'Loading…' : 'Nothing learned yet.'}
                  disabled={memory === null}
                  onChange={(e) => setMemory(e.target.value)}
                  onBlur={(e) => saveMemory(e.target.value)}
                />
                <div className="set-inline-actions">
                  <button className="btn" disabled={consolidating} onClick={() => void consolidateNow()}>
                    {consolidating ? 'Consolidating…' : 'Consolidate now'}
                  </button>
                </div>
              </div>
            </>
          )}

          {section === 'privacy' && (
            <>
              <h2 className="set-section-title">Privacy</h2>
              <p className="set-section-sub">
                Content flagged as a secret is masked in the UI and is never indexed, enriched,
                embedded, or sent to any AI provider.
              </p>
              <div className="set-block">
                <div className="set-label">Ignored apps</div>
                <div className="set-sub">Copies made in these apps are never captured.</div>
                <div className="list-editor">
                  {s.ignoreApps.map((app, i) => (
                    <div key={`${app}:${i}`} className="list-item-row">
                      <span className="list-item-text mono">{app}</span>
                      <button
                        className="icon-btn"
                        title="Remove"
                        onClick={() => patch({ ignoreApps: s.ignoreApps.filter((_, j) => j !== i) })}
                      >
                        <TrashIcon size={13} />
                      </button>
                    </div>
                  ))}
                  <div className="list-add-row">
                    <input
                      className="set-input"
                      value={newApp}
                      placeholder="app name, e.g. keepassxc"
                      onChange={(e) => setNewApp(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') addIgnoreApp()
                      }}
                    />
                    <button className="btn" onClick={addIgnoreApp}>
                      Add
                    </button>
                  </div>
                </div>
              </div>
              <Row
                label="Auto-clear secrets"
                sub="Clear flagged secrets from the system clipboard shortly after they are copied."
              >
                <Toggle
                  checked={s.secretAutoClear}
                  onChange={(v) => patch({ secretAutoClear: v })}
                />
              </Row>
              <Row
                label="Export history"
                sub="Writes a JSON file of your clipboard history. Items flagged as secrets are excluded."
              >
                <div className="set-stack">
                  <button
                    className="btn"
                    disabled={exporting}
                    onClick={() => void exportHistory()}
                  >
                    {exporting ? 'Exporting…' : 'Export…'}
                  </button>
                  {exportNote && (
                    <div
                      className={'set-note' + (exportNote.ok ? ' ok' : ' warn')}
                      title={exportNote.title}
                    >
                      {exportNote.text}
                    </div>
                  )}
                </div>
              </Row>
            </>
          )}

          {section === 'voice' && (
            <>
              <h2 className="set-section-title">Voice</h2>
              <p className="set-section-sub">
                Samples of your writing voice. Rewrite prompts use these so AI rewrites sound like
                you, not like a press release.
              </p>
              <div className="list-editor">
                {s.voiceSamples.map((sample, i) => (
                  <VoiceSample
                    key={i}
                    value={sample}
                    onCommit={(v) =>
                      patch({ voiceSamples: s.voiceSamples.map((x, j) => (j === i ? v : x)) })
                    }
                    onRemove={() =>
                      patch({ voiceSamples: s.voiceSamples.filter((_, j) => j !== i) })
                    }
                  />
                ))}
                <button className="btn" onClick={() => patch({ voiceSamples: [...s.voiceSamples, ''] })}>
                  <PlusIcon size={12} /> Add sample
                </button>
              </div>
            </>
          )}

          {section === 'actions' && (
            <>
              <h2 className="set-section-title">Actions</h2>
              <p className="set-section-sub">
                Saved actions appear in the palette's Action Mode (Tab). A single-key binding runs
                the action instantly while the action input is empty.
              </p>
              {savedActions.map((a) => (
                <ActionEditor
                  key={a.id}
                  action={a}
                  onSave={saveAction}
                  onDelete={() => deleteAction(a.id)}
                />
              ))}
              <button className="btn primary" onClick={addAction}>
                <PlusIcon size={12} /> Add AI action
              </button>
            </>
          )}
        </main>
      </div>
      <Toasts toasts={toasts} />
    </div>
  )
}
