import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { AppSettings, DictationSuggestion, ProviderId, ProviderStatus } from '@shared/types'
import { invoke, on } from '../lib/ipc'
import { IS_MAC, GLOBAL_MOD } from '../lib/keys'
import { DEFAULT_DICTATE_CHORD, chordWarning, formatChord, parseChord } from '@shared/chord'
import { useTheme } from '../hooks/useTheme'
import { useToasts } from '../hooks/useToasts'
import DragStrip from './DragStrip'
import Toasts from './Toasts'
import { TrashIcon } from './icons'

/** The two direct-API providers. Every AI call goes to one of these. */
type ApiProvider = Extract<ProviderId, 'openai' | 'fireworks'>

const PROVIDERS: Array<{ id: ApiProvider; label: string }> = [
  { id: 'openai', label: 'OpenAI' },
  { id: 'fireworks', label: 'Fireworks (DeepSeek)' }
]

/** Model choices per provider. The first entry is the default when nothing is saved. */
const MODEL_CHOICES: Record<ApiProvider, string[]> = {
  openai: ['gpt-6-luna', 'gpt-5.4-nano'],
  fireworks: ['accounts/fireworks/models/deepseek-v4p1-flash']
}

/**
 * Model dropdown for one provider. A saved id that has since left the list stays
 * visible as its own option rather than the select silently showing the default
 * while calls still go to the old model.
 */
function ModelSelect({
  provider,
  value,
  onCommit
}: {
  provider: ApiProvider
  value: string
  onCommit: (v: string) => void
}) {
  const choices = MODEL_CHOICES[provider]
  const stray = value !== '' && !choices.includes(value)
  return (
    <select
      className="set-input"
      value={value || choices[0]}
      onChange={(e) => onCommit(e.target.value)}
    >
      {choices.map((m, i) => (
        <option key={m} value={m}>
          {i === 0 ? `${m} (default)` : m}
        </option>
      ))}
      {stray && <option value={value}>{value} (no longer offered)</option>}
    </select>
  )
}

const SECTIONS = [
  ['general', 'General'],
  ['ai', 'AI'],
  ['intelligence', 'Intelligence'],
  ['privacy', 'Privacy']
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
  badge,
  children
}: {
  label: string
  sub?: string
  /** Small pill after the label, e.g. "Beta" for experimental settings. */
  badge?: string
  children: ReactNode
}) {
  return (
    <div className="set-row">
      <div className="set-row-text">
        <div className="set-label">
          {label}
          {badge && <span className="set-badge">{badge}</span>}
        </div>
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
  onCommit,
  placeholder
}: {
  value: string
  onCommit: (v: string) => void
  placeholder?: string
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null)
  const [draft, setDraft] = useSyncedDraft(value, ref)
  return (
    <textarea
      ref={ref}
      className="set-textarea identity-textarea"
      spellCheck={false}
      placeholder={placeholder ?? 'clipboard dot md => clipboard.md\nParakeet\nsherpa => sherpa-onnx'}
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

// ── settings window ──────────────────────────────────────────────────────────

export default function Settings() {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [providers, setProviders] = useState<ProviderStatus[]>([])
  const [section, setSection] = useState<SectionId>('general')
  const [suggestions, setSuggestions] = useState<DictationSuggestion[]>([])
  const [savedFlash, setSavedFlash] = useState(false)
  const [newApp, setNewApp] = useState('')
  const [exporting, setExporting] = useState(false)
  const [exportNote, setExportNote] = useState<{ ok: boolean; text: string; title?: string } | null>(
    null
  )
  const { toasts, addToast } = useToasts()
  const theme = useTheme(settings?.theme)
  const flashTimer = useRef(0)

  const flashSaved = useCallback(() => {
    setSavedFlash(true)
    window.clearTimeout(flashTimer.current)
    flashTimer.current = window.setTimeout(() => setSavedFlash(false), 1200)
  }, [])

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

  // Learned correction suggestions: seed once, then follow main's broadcasts.
  useEffect(() => {
    invoke('dictation:suggestions:list')
      .then(setSuggestions)
      .catch(() => {})
    return on('dictation:suggestions:changed', (p) => setSuggestions(p.suggestions))
  }, [])

  // Provider availability was read once on mount and never again, so the status row
  // kept saying a provider had no key long after one was pasted into the field right
  // above it — the only way to see the truth was to close and reopen Settings.
  // Debounced because a settings change fires per keystroke-commit, and each refresh
  // re-runs the availability probes.
  useEffect(() => {
    let timer = 0
    const off = on('settings:changed', () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        invoke('providers:status')
          .then(setProviders)
          .catch(() => {})
      }, 400)
    })
    return () => {
      window.clearTimeout(timer)
      off()
    }
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
                    ? 'Registered at launch: ⌘⇧V palette · R rewrite · S screenshot. Dictation, hold to talk: 🌐 (Fn) or ⌘⇧D plain · ⌘⌥D AI cleanup. If 🌐 also triggers a system action, set Keyboard → "Press 🌐 key to" → Do Nothing.'
                    : 'Registered as GNOME custom keybindings — edit them in system Settings → Keyboard → Custom Shortcuts.'
                }
              >
                <kbd className="hotkey-kbd">
                  {IS_MAC ? `${GLOBAL_MOD}V` : s.hotkeyHint}
                </kbd>
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
              {IS_MAC && (
                <Row
                  label="Dictation modes"
                  sub="Both record identically and differ only in what happens to the transcript. Hold to talk, release to finish."
                >
                  <div className="set-static">
                    <div>
                      <kbd className="hotkey-kbd">🌐 / ⌘⇧D</kbd> plain — offline, pasted
                    </div>
                    <div>
                      <kbd className="hotkey-kbd">⌘⌥D</kbd> AI cleanup
                    </div>
                  </div>
                </Row>
              )}
              <Row
                label="AI cleanup style"
                sub="What the AI cleanup key does with a transcript. Only used by that key — plain dictation stays offline and untouched."
              >
                <select
                  className="set-input"
                  value={s.dictation.enhancePreset ?? 'standard'}
                  onChange={(e) =>
                    patch({
                      dictation: {
                        ...s.dictation,
                        enhancePreset: e.target.value as 'standard' | 'positive'
                      }
                    })
                  }
                >
                  <option value="standard">Standard — fix mechanics, keep my words</option>
                  <option value="positive">Positive — soften harsh wording, otherwise standard</option>
                  <option value="custom">Custom — my own instructions</option>
                </select>
              </Row>
              {s.dictation.enhancePreset === 'custom' && (
                <Row
                  label="Custom instructions"
                  sub="Tells the model what to do with each transcript. This replaces the built-in rules, so describe everything you want — including whether to keep your wording. Leave empty to fall back to Standard."
                >
                  <DictionaryField
                    value={s.dictation.enhanceCustomPrompt ?? ''}
                    onCommit={(v) =>
                      patch({
                        dictation: { ...s.dictation, enhanceCustomPrompt: v || undefined }
                      })
                    }
                    placeholder={
                      'Clean up dictated speech: remove filler words, fix punctuation\nand capitalisation, and keep my wording and tone.\nTranslate the result into Spanish.'
                    }
                  />
                </Row>
              )}
              {!IS_MAC && (
                <Row
                  label="Hold-to-talk chord (AI cleanup)"
                  sub="Optional second key. Records the same way, then sends the transcript to your AI provider to fix self-corrections, filler words and misheard words. Leave empty to keep every dictation offline."
                >
                  <ChordField
                    value={s.dictateEnhanceChord ?? ''}
                    onCommit={(v) => patch({ dictateEnhanceChord: v })}
                  />
                </Row>
              )}
            </>
          )}

          {section === 'ai' && (
            <>
              <h2 className="set-section-title">AI</h2>
              <p className="set-section-sub">
                Direct API calls with your own keys. Fireworks is preferred automatically when its
                key is set.
              </p>
              <Row
                label="OpenAI API key"
                sub="Stored in your settings file. If OPENAI_API_KEY is exported in your shell, it is copied in here once at startup — after that this field is the only source, so edits here always win."
              >
                <TextField
                  value={s.apiKeys?.openai ?? ''}
                  password
                  placeholder="sk-…"
                  onCommit={(v) =>
                    patch({ apiKeys: { ...(s.apiKeys ?? {}), openai: v || undefined } })
                  }
                />
              </Row>
              <Row
                label="Fireworks API key"
                sub="Enables DeepSeek Flash, which is cheap and fast for short text prompts. Stored in your settings file."
              >
                <TextField
                  value={s.apiKeys?.fireworks ?? ''}
                  password
                  placeholder="fw_…"
                  onCommit={(v) =>
                    patch({ apiKeys: { ...(s.apiKeys ?? {}), fireworks: v || undefined } })
                  }
                />
              </Row>
              <p className="set-section-sub">
                AI calls go straight to Fireworks when it has a key, then OpenAI.
              </p>
              <div className="set-block">
                <div className="set-label">Models</div>
                <div className="set-sub">Fast models by default.</div>
                <div className="model-grid">
                  {PROVIDERS.map((p) => (
                    <label key={p.id} className="model-row">
                      <span className="model-provider">{p.label}</span>
                      <ModelSelect
                        provider={p.id}
                        value={s.models[p.id] ?? ''}
                        onCommit={(v) => patch({ models: { ...s.models, [p.id]: v } })}
                      />
                    </label>
                  ))}
                </div>
              </div>
              <div className="set-block">
                <div className="set-label">Provider status</div>
                <div className="provider-list">
                  {PROVIDERS.map(({ id, label }) => {
                    const p = providers.find((x) => x.id === id)
                    return (
                      <div key={id} className="provider-row">
                        <span className={'dot' + (p?.available ? ' ok' : '')} />
                        <span className="provider-name">{label}</span>
                        <span className="provider-detail" title={p?.detail}>
                          {p?.detail ?? 'No status reported'}
                        </span>
                      </div>
                    )
                  })}
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
              <Row label="Enrichment" sub="Auto-title, tag, and classify new clips, using the API keys under AI.">
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
              <Row
                label="Transcription"
                sub="Speech-to-text engine for dictation."
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
                sub="Input device for dictation."
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
                label="Style"
                sub="How the transcript is formatted. Casual lowercases sentence openers and drops the final full stop, the way people type in chat — proper nouns, acronyms and “I” are left alone."
              >
                <select
                  className="set-input"
                  value={s.dictation.style ?? 'as-spoken'}
                  onChange={(e) =>
                    patch({
                      dictation: {
                        ...s.dictation,
                        style: e.target.value as 'as-spoken' | 'casual'
                      }
                    })
                  }
                >
                  <option value="as-spoken">As spoken</option>
                  <option value="casual">Casual (lowercase)</option>
                </select>
              </Row>
              <Row
                label="Numbers as numerals"
                sub="“another twenty items” → “another 20 items”. Follows the usual convention: words below ten, numerals from ten up, and always numerals with a unit — so “one click install” is left alone."
              >
                <Toggle
                  checked={s.dictation.numbers !== false}
                  onChange={(v) => patch({ dictation: { ...s.dictation, numbers: v } })}
                />
              </Row>
              <Row
                label="Per-app styles"
                sub="Override the style for specific apps, one per line: app => style, where app matches part of the window class (slack, wezterm, chrome). Empty means the same style everywhere."
              >
                <DictionaryField
                  value={s.dictation.profiles ?? ''}
                  onCommit={(v) =>
                    patch({ dictation: { ...s.dictation, profiles: v || undefined } })
                  }
                  placeholder={'slack => casual\nwezterm => as-spoken'}
                />
              </Row>
              <Row
                label="Clean up transcripts"
                sub={'Remove "um" and "uh" and tidy the punctuation left behind. Runs offline. Ambiguous fillers like "like" and "you know" are left alone — only a model can tell those from ordinary words.'}
              >
                <Toggle
                  checked={s.dictation.cleanup !== false}
                  onChange={(v) => patch({ dictation: { ...s.dictation, cleanup: v } })}
                />
              </Row>
              <Row
                label="Tech vocabulary"
                sub={
                  'Spell tech proper nouns right out of the box — "open ai" → OpenAI, "get hub" → GitHub, "cuber netes" → Kubernetes. Lowercased automatically in casual style. Add your own below.'
                }
              >
                <Toggle
                  checked={s.dictation.builtinVocabulary !== false}
                  onChange={(v) => patch({ dictation: { ...s.dictation, builtinVocabulary: v } })}
                />
              </Row>
              <Row
                label="Learn from my corrections"
                badge="Beta"
                sub="When you fix a mis-transcribed word right after dictating — in the app you pasted into (re-copy the corrected text), or with “Correct last dictation” in the menu bar — offer to remember it as a rule below. Runs on-device; nothing is sent anywhere. Off by default."
              >
                <Toggle
                  checked={s.dictation.learnCorrections === true}
                  onChange={(v) => patch({ dictation: { ...s.dictation, learnCorrections: v } })}
                />
              </Row>
              {suggestions.length > 0 && (
                <div className="set-suggestions">
                  {suggestions.map((sg) => (
                    <div key={sg.key} className="set-suggestion">
                      <div className="set-suggestion-text">
                        <span className="set-suggestion-rule">
                          <b>{sg.from}</b> → <b>{sg.to}</b>
                        </span>
                        <span className="set-suggestion-reason">{sg.reason}</span>
                      </div>
                      <div className="set-suggestion-actions">
                        <button
                          className="linkish"
                          onClick={() => void invoke('dictation:suggestion:accept', sg.key)}
                        >
                          Add
                        </button>
                        <button
                          className="linkish set-suggestion-dismiss"
                          onClick={() => void invoke('dictation:suggestion:dismiss', sg.key)}
                        >
                          Dismiss
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
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

        </main>
      </div>
      <Toasts toasts={toasts} />
    </div>
  )
}
