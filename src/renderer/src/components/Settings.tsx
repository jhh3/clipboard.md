import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type {
  AppSettings,
  ProviderId,
  ProviderLane,
  ProviderStatus,
  SavedAction
} from '@shared/types'
import { invoke, on } from '../lib/ipc'
import { useTheme } from '../hooks/useTheme'
import { useToasts } from '../hooks/useToasts'
import DragStrip from './DragStrip'
import Toasts from './Toasts'
import { PlusIcon, TrashIcon } from './icons'

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

const SECTIONS = [
  ['general', 'General'],
  ['providers', 'AI Providers'],
  ['intelligence', 'Intelligence'],
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

  const flashSaved = useCallback(() => {
    setSavedFlash(true)
    window.clearTimeout(flashTimer.current)
    flashTimer.current = window.setTimeout(() => setSavedFlash(false), 1200)
  }, [])

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
                label="Global hotkey"
                sub="GNOME keybindings are managed in system Settings → Keyboard → Custom Shortcuts."
              >
                <kbd className="hotkey-kbd">{s.hotkeyHint}</kbd>
              </Row>
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
              <Row label="Enrichment lane" sub="How titles, tags, and OCR are generated.">
                <select
                  className="set-input"
                  value={s.enrichment.lane}
                  onChange={(e) =>
                    patch({
                      enrichment: { ...s.enrichment, lane: e.target.value as ProviderLane }
                    })
                  }
                >
                  <option value="subscription">Subscription</option>
                  <option value="api">API key</option>
                </select>
              </Row>
              <Row label="Enrichment provider">
                <ProviderSelect
                  value={s.enrichment.provider}
                  onChange={(p) => patch({ enrichment: { ...s.enrichment, provider: p } })}
                />
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
                      <TextField
                        value={s.models[p.id] ?? ''}
                        placeholder={MODEL_PLACEHOLDERS[p.id]}
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
