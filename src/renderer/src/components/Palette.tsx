import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ClipItem, SmartCollection, PasteOutcome } from '@shared/types'
import { invoke, on } from '../lib/ipc'
import { blobToB64, configuredMicDeviceId, openMicStream, preferredAudioMime } from '../lib/audio'
import { MOD } from '../lib/keys'
import { useSearch } from '../hooks/useSearch'
import { useKeymap } from '../hooks/useKeymap'
import { useTheme } from '../hooks/useTheme'
import { useToasts } from '../hooks/useToasts'
import SearchBar from './SearchBar'
import FilterChips, { type Chip } from './FilterChips'
import ItemList from './ItemList'
import PreviewPane from './PreviewPane'
import HelpOverlay from './HelpOverlay'
import Markdown from './Markdown'
import Toasts from './Toasts'
import { CameraIcon, GearIcon, MicIcon, SparkIcon } from './icons'

const KIND_CHIPS: Chip[] = [
  { id: 'all', label: 'All' },
  { id: 'text', label: 'Text', kind: 'text' },
  { id: 'image', label: 'Images', kind: 'image' },
  { id: 'link', label: 'Links', kind: 'link' },
  { id: 'code', label: 'Code', kind: 'code' },
  { id: 'files', label: 'Files', kind: 'files' }
]

/**
 * A one-shot ask: a single direct model call whose answer streams in place. There is
 * no session behind it; asking again starts fresh.
 */
type Ask = {
  id: string | null
  question: string
  attachment: ClipItem | null
  answer: string
  done: boolean
  error?: string
}

/** ⌘⇧R: the captured selection, one free-text instruction, and the result. */
type RewriteState = {
  text: string
  out: string | null
}

const HIDE_DELAY_MS = 900

export default function Palette() {
  // ── core state ────────────────────────────────────────────────────────────
  const [query, setQuery] = useState('')
  const [activeChipId, setActiveChipId] = useState('all')
  const [collections, setCollections] = useState<SmartCollection[]>([])
  /**
   * -1 is the "ask" row, and the default: with the input focused, Enter asks.
   * Arrowing down moves into clipboard history.
   */
  const [sel, setSel] = useState(-1)
  const [ask, setAsk] = useState<Ask | null>(null)
  const [rewrite, setRewrite] = useState<RewriteState | null>(null)
  const [rewritePrompt, setRewritePrompt] = useState('')
  /** Clip riding along with the next ask (Tab on an item). */
  const [attachment, setAttachment] = useState<ClipItem | null>(null)
  const [micState, setMicState] = useState<'idle' | 'recording' | 'transcribing'>('idle')
  const [showHelp, setShowHelp] = useState(false)
  const [running, setRunning] = useState(false)
  const [shownTick, setShownTick] = useState(0)
  const { toasts, addToast } = useToasts()
  const theme = useTheme()

  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const rewriteInputRef = useRef<HTMLInputElement | null>(null)
  /** Synchronous double-submit guard: `running` state lags a render behind. */
  const runningRef = useRef(false)

  // ── chips / filters ───────────────────────────────────────────────────────
  const chips = useMemo<Chip[]>(
    () => [
      ...KIND_CHIPS,
      ...collections.map((c) => ({
        id: `col:${c.id}`,
        label: c.title,
        collection: c.id,
        count: c.count
      })),
      { id: 'pinned', label: 'Pinned', collection: 'pinned' }
    ],
    [collections]
  )
  const activeChip = chips.find((c) => c.id === activeChipId) ?? chips[0]
  const askText = query.trim()

  // ── search ────────────────────────────────────────────────────────────────
  const { items, total, searchMode, refresh } = useSearch(
    query,
    activeChip.kind ?? 'all',
    activeChip.collection
  )
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh

  const { visible, pinnedCount } = useMemo(() => {
    const pinned = items.filter((i) => i.pinned)
    const rest = items.filter((i) => !i.pinned)
    return { visible: [...pinned, ...rest], pinnedCount: pinned.length }
  }, [items])

  const selectedItem: ClipItem | null = sel >= 0 ? (visible[sel] ?? null) : null

  // Typing recomposes the ask/search — selection returns to the ask row.
  useEffect(() => setSel(-1), [query, activeChipId])
  useEffect(() => {
    setSel((s) => (s < 0 ? s : visible.length === 0 ? -1 : Math.min(s, visible.length - 1)))
  }, [visible.length])

  // ── collections ───────────────────────────────────────────────────────────
  const loadCollections = useCallback(() => {
    invoke('collections:list')
      .then(setCollections)
      .catch(() => {})
  }, [])

  useEffect(() => {
    loadCollections()
  }, [loadCollections])

  // ── main-process events ───────────────────────────────────────────────────
  useEffect(() => {
    const offItems = on('items:changed', () => {
      void refreshRef.current()
      loadCollections()
    })
    const offToast = on('toast', (t) => addToast(t.message, t.kind))
    // Smart collections live in settings — re-pull them whenever settings change.
    const offSettings = on('settings:changed', () => loadCollections())
    const resetView = (): void => {
      setAsk((a) => {
        if (a?.id && !a.done) void invoke('ask:cancel', a.id)
        return null
      })
      setQuery('')
      setSel(-1)
      setAttachment(null)
      setShowHelp(false)
      setRewritePrompt('')
    }
    // Reset while hidden, so the next show's first frame is already clean.
    const offHidden = on('palette:hidden', () => {
      resetView()
      setRewrite(null)
    })
    const offShown = on('palette:shown', (p) => {
      resetView()
      if (p.mode === 'rewrite' && p.rewriteText) {
        setRewrite({ text: p.rewriteText, out: null })
      } else {
        setRewrite(null)
        setActiveChipId(
          p.collection ? (p.collection === 'pinned' ? 'pinned' : `col:${p.collection}`) : 'all'
        )
      }
      setShownTick((t) => t + 1)
    })
    const offDelta = on('ask:delta', (d) =>
      setAsk((a) => (a && a.id === d.id ? { ...a, answer: a.answer + d.text } : a))
    )
    const offDone = on('ask:done', (d) =>
      setAsk((a) =>
        a && a.id === d.id
          ? { ...a, answer: d.text ?? a.answer, done: true, error: d.error }
          : a
      )
    )
    return () => {
      offItems()
      offToast()
      offShown()
      offHidden()
      offSettings()
      offDelta()
      offDone()
    }
  }, [addToast, loadCollections])

  // ── focus management ──────────────────────────────────────────────────────
  useEffect(() => {
    if (rewrite) {
      if (rewrite.out) (document.activeElement as HTMLElement | null)?.blur()
      else rewriteInputRef.current?.focus()
      return
    }
    searchInputRef.current?.focus()
  }, [shownTick, rewrite, ask === null])

  // ── paste / copy / mutate ─────────────────────────────────────────────────
  const hideSoon = useCallback(() => {
    window.setTimeout(() => void invoke('window:hide'), HIDE_DELAY_MS)
  }, [])

  const handleOutcome = useCallback(
    (outcome: PasteOutcome) => {
      if (outcome.method === 'injected') {
        void invoke('window:hide')
      } else {
        addToast(outcome.message ?? 'Copied — press Ctrl+V to paste', 'info')
        hideSoon()
      }
    },
    [addToast, hideSoon]
  )

  const pasteItem = useCallback(
    async (item: ClipItem, plain: boolean) => {
      try {
        handleOutcome(await invoke('item:paste', item.id, { plain }))
      } catch {
        addToast('Paste failed', 'error')
      }
    },
    [handleOutcome, addToast]
  )

  const copyItem = useCallback(
    async (item: ClipItem) => {
      try {
        await invoke('item:copy', item.id)
        addToast('Copied to clipboard', 'success')
        hideSoon()
      } catch {
        addToast('Copy failed', 'error')
      }
    },
    [addToast, hideSoon]
  )

  const togglePin = useCallback(async (item: ClipItem) => {
    await invoke('item:pin', item.id, !item.pinned).catch(() => {})
    void refreshRef.current()
  }, [])

  const deleteItem = useCallback(async (item: ClipItem) => {
    await invoke('item:delete', item.id).catch(() => {})
    void refreshRef.current()
  }, [])

  // From the ask row, item shortcuts act on the first item — the nearest thing on screen.
  const actionTarget = useCallback(
    (): ClipItem | null => (sel >= 0 ? (visible[sel] ?? null) : (visible[0] ?? null)),
    [visible, sel]
  )

  // ── ask ───────────────────────────────────────────────────────────────────
  const startAsk = useCallback(async () => {
    const question = askText
    if (!question) return
    if (ask?.id && !ask.done) void invoke('ask:cancel', ask.id)
    const attach = attachment
    setAsk({ id: null, question, attachment: attach, answer: '', done: false })
    setQuery('')
    setAttachment(null)
    try {
      const { id } = await invoke('ask:start', { text: question, itemId: attach?.id })
      // Events can only match once the id is known; none can arrive before this
      // resolves, because main emits them after the call has returned.
      setAsk((a) => (a && a.question === question && a.id === null ? { ...a, id } : a))
    } catch (err) {
      setAsk((a) =>
        a ? { ...a, done: true, error: err instanceof Error ? err.message : 'Ask failed' } : a
      )
    }
  }, [askText, ask, attachment])

  const exitAsk = useCallback(() => {
    if (ask?.id && !ask.done) void invoke('ask:cancel', ask.id)
    setAsk(null)
  }, [ask])

  const pasteAnswer = useCallback(async () => {
    if (!ask?.done || !ask.answer) return
    try {
      handleOutcome(await invoke('paste:text', { text: ask.answer }))
    } catch {
      addToast('Paste failed', 'error')
    }
  }, [ask, handleOutcome, addToast])

  const copyAnswer = useCallback(async () => {
    if (!ask?.answer) return
    try {
      await navigator.clipboard.writeText(ask.answer)
      addToast('Answer copied', 'success')
    } catch {
      addToast('Copy failed', 'error')
    }
  }, [ask, addToast])

  /** Tab on an item: attach it to the next ask. */
  const attachClip = useCallback(() => {
    const item = actionTarget()
    if (!item) return
    if (item.secret) {
      addToast('Secret clips are never sent to a model', 'error')
      return
    }
    setAttachment(item)
    setSel(-1)
    searchInputRef.current?.focus()
  }, [actionTarget, addToast])

  // ── voice (mic → transcribe → INPUT, never auto-sent) ─────────────────────
  const recRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const micStreamRef = useRef<MediaStream | null>(null)

  /**
   * Put a transcript where the user is actually typing: the focused text field if
   * there is one (the rewrite instruction), else the search/ask box. Writing to a
   * React-controlled input needs the native value setter plus an input event, or the
   * component's state never learns about the change.
   */
  const insertTranscript = useCallback((text: string) => {
    const t = text.trim()
    if (!t) return
    const el = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null
    const editable =
      !!el &&
      (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') &&
      !el.readOnly &&
      !el.disabled &&
      el !== searchInputRef.current
    if (editable) {
      const start = el.selectionStart ?? el.value.length
      const end = el.selectionEnd ?? start
      const before = el.value.slice(0, start)
      const pad = before && !/\s$/.test(before) ? ' ' : ''
      const next = before + pad + t + el.value.slice(end)
      const proto =
        el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, next)
      el.dispatchEvent(new Event('input', { bubbles: true }))
      const caret = start + pad.length + t.length
      el.setSelectionRange(caret, caret)
      return
    }
    setQuery((q) => (q.trim() ? `${q.trimEnd()} ${t}` : t))
    searchInputRef.current?.focus()
  }, [])
  const insertRef = useRef(insertTranscript)
  insertRef.current = insertTranscript

  const finishMic = useCallback(async () => {
    const rec = recRef.current
    recRef.current = null
    micStreamRef.current?.getTracks().forEach((t) => t.stop())
    micStreamRef.current = null
    const mime = rec?.mimeType || 'audio/webm'
    const blob = new Blob(chunksRef.current, { type: mime })
    chunksRef.current = []
    if (blob.size === 0) {
      setMicState('idle')
      return
    }
    setMicState('transcribing')
    try {
      const res = await invoke('scratch:transcribe', { audioB64: await blobToB64(blob), mime })
      if (res.ok && res.text?.trim()) {
        insertRef.current(res.text)
      } else {
        addToast(res.error ?? 'Heard nothing', 'error')
      }
    } catch {
      addToast('Transcription failed', 'error')
    } finally {
      setMicState('idle')
    }
  }, [addToast])

  const finishMicRef = useRef(finishMic)
  finishMicRef.current = finishMic

  /** getUserMedia can take seconds (first-ever permission prompt); without this
   *  guard, a repeated ⌘D opens N streams and only the last ever gets stopped. */
  const micOpeningRef = useRef(false)

  const toggleMic = useCallback(async () => {
    if (micState === 'transcribing' || micOpeningRef.current) return
    if (recRef.current) {
      recRef.current.stop()
      return
    }
    micOpeningRef.current = true
    try {
      const { stream } = await openMicStream(await configuredMicDeviceId())
      // The palette may have hidden while the permission prompt was up.
      if (document.hidden) {
        stream.getTracks().forEach((t) => t.stop())
        return
      }
      micStreamRef.current = stream
      const rec = new MediaRecorder(stream, { mimeType: preferredAudioMime() })
      chunksRef.current = []
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data)
      }
      rec.onstop = () => void finishMicRef.current()
      rec.start(250)
      recRef.current = rec
      setMicState('recording')
    } catch {
      addToast('Microphone unavailable — check permissions', 'error')
    } finally {
      micOpeningRef.current = false
    }
  }, [micState, addToast])

  /** Abandon any in-flight recording without transcribing (palette hidden). */
  const cancelMic = useCallback(() => {
    if (recRef.current) {
      recRef.current.onstop = null
      recRef.current.stop()
      recRef.current = null
    }
    micStreamRef.current?.getTracks().forEach((t) => t.stop())
    micStreamRef.current = null
    chunksRef.current = []
    setMicState('idle')
  }, [])

  // A hidden palette must never keep the microphone open.
  useEffect(() => {
    const onVis = (): void => {
      if (document.hidden) cancelMic()
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [cancelMic])

  // Hold-to-talk finished while the palette was open: the transcript belongs in the
  // ask input (main routes it here — see ipc.ts), NOT auto-sent.
  useEffect(() => {
    return on('palette:dictation', (p) => insertRef.current(p.text))
  }, [])

  // ── screenshot / settings entry points ────────────────────────────────────
  const captureScreenshot = useCallback(async () => {
    try {
      const res = await invoke('capture:screenshot')
      if (res.ok) addToast('Captured to history', 'success')
      else addToast(res.error ?? 'Screenshot cancelled', 'error')
    } catch {
      addToast('Screenshot failed', 'error')
    }
  }, [addToast])

  const openSettings = useCallback(() => {
    void invoke('window:open-settings').catch(() => {})
  }, [])

  // ── rewrite mini-flow ─────────────────────────────────────────────────────
  const runRewrite = useCallback(async () => {
    if (!rewrite || runningRef.current) return
    runningRef.current = true
    setRunning(true)
    try {
      const res = await invoke('rewrite:run', { prompt: rewritePrompt.trim() || undefined })
      if (!res.ok || res.output == null) {
        addToast(res.error ?? 'Rewrite failed', 'error')
        return
      }
      const output = res.output
      setRewrite((r) => (r ? { ...r, out: output } : r))
    } catch {
      addToast('Rewrite failed', 'error')
    } finally {
      runningRef.current = false
      setRunning(false)
    }
  }, [rewrite, rewritePrompt, addToast])

  const applyRewrite = useCallback(async () => {
    const out = rewrite?.out
    if (!out) return
    try {
      const outcome = await invoke('rewrite:apply', { output: out })
      setRewrite(null)
      if (outcome.method === 'injected') {
        void invoke('window:hide')
      } else {
        addToast(outcome.message ?? 'Copied — press Ctrl+V to replace the selection', 'info')
        hideSoon()
      }
    } catch {
      addToast('Apply failed', 'error')
    }
  }, [rewrite, addToast, hideSoon])

  const copyRewrite = useCallback(async () => {
    const out = rewrite?.out
    if (!out) return
    try {
      await navigator.clipboard.writeText(out)
      addToast('Result copied to clipboard', 'success')
      hideSoon()
    } catch {
      addToast('Copy failed', 'error')
    }
  }, [rewrite, addToast, hideSoon])

  // ── chip cycling ──────────────────────────────────────────────────────────
  const cycleKind = useCallback(() => {
    const idx = KIND_CHIPS.findIndex((c) => c.id === activeChipId)
    setActiveChipId(KIND_CHIPS[(idx + 1) % KIND_CHIPS.length].id)
  }, [activeChipId])

  const cycleChip = useCallback(
    (dir: 1 | -1) => {
      const idx = chips.findIndex((c) => c.id === activeChipId)
      const next = (idx + dir + chips.length) % chips.length
      setActiveChipId(chips[next].id)
    },
    [chips, activeChipId]
  )

  // ── keyboard model ────────────────────────────────────────────────────────
  useKeymap((e) => {
    const mod = e.ctrlKey || e.metaKey

    if (mod && e.shiftKey && e.key.toLowerCase() === 's') {
      e.preventDefault()
      void captureScreenshot()
      return
    }

    if (mod && e.key === '/' && !rewrite) {
      e.preventDefault()
      setShowHelp((h) => !h)
      return
    }
    if (showHelp) {
      if (e.key === 'Escape') {
        e.preventDefault()
        setShowHelp(false)
      }
      return
    }

    if (rewrite) {
      if (e.key === 'Escape') {
        e.preventDefault()
        // Step back one level: result → instruction → close.
        if (rewrite.out) setRewrite({ ...rewrite, out: null })
        else {
          setRewrite(null)
          void invoke('window:hide')
        }
        return
      }
      if (running) return
      if (e.key === 'Enter') {
        e.preventDefault()
        if (!rewrite.out) void runRewrite()
        else if (mod) void copyRewrite()
        else void applyRewrite()
      }
      return
    }

    // Mic toggle. `repeat` filtered: holding ⌘D auto-repeats, and a repeat landing
    // after the recorder starts would stop it.
    if (mod && e.key.toLowerCase() === 'd' && !e.repeat) {
      e.preventDefault()
      void toggleMic()
      return
    }

    if (ask) {
      if (e.key === 'Escape') {
        e.preventDefault()
        exitAsk()
        return
      }
      if (e.key === 'Enter' && mod) {
        e.preventDefault()
        void copyAnswer()
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        // Typed text is a new question; an empty box pastes the answer.
        if (askText) void startAsk()
        else void pasteAnswer()
        return
      }
      if (!mod && !e.altKey && e.key.length === 1 && document.activeElement !== searchInputRef.current) {
        searchInputRef.current?.focus()
      }
      return
    }

    // ── normal mode ──
    if (e.key === 'Tab') {
      e.preventDefault()
      attachClip()
      return
    }
    if (e.key === 'ArrowDown' && !mod) {
      e.preventDefault()
      setSel((s) => Math.min(s + 1, Math.max(-1, visible.length - 1)))
      return
    }
    if (e.key === 'ArrowUp' && !mod) {
      e.preventDefault()
      setSel((s) => Math.max(s - 1, -1))
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      if (sel < 0) {
        // The ask row: Enter asks. With nothing typed there is nothing to ask —
        // fall through to the first item, honouring the same modifiers as an
        // explicit selection (mod+Enter must still COPY).
        if (askText) {
          void startAsk()
          return
        }
        // An attachment without a question is a half-composed ask, not "paste latest".
        if (attachment || !visible[0]) return
        if (mod) void copyItem(visible[0])
        else void pasteItem(visible[0], e.shiftKey)
        return
      }
      if (!selectedItem) return
      if (mod) void copyItem(selectedItem)
      else void pasteItem(selectedItem, e.shiftKey)
      return
    }
    if (mod && e.key >= '1' && e.key <= '9') {
      e.preventDefault()
      const item = visible[Number(e.key) - 1]
      if (item) void pasteItem(item, false)
      return
    }
    // Pin/delete act on the effective item — the top match while the ask row is
    // selected, so "type a filter, ⌘⌫" works without arrowing down first.
    if (mod && e.key.toLowerCase() === 'p') {
      e.preventDefault()
      const t = actionTarget()
      if (t) void togglePin(t)
      return
    }
    if (mod && e.key === 'Backspace') {
      e.preventDefault()
      const t = actionTarget()
      if (t) void deleteItem(t)
      return
    }
    if (mod && e.key.toLowerCase() === 'f') {
      e.preventDefault()
      cycleKind()
      return
    }
    if (mod && e.key === 'ArrowRight') {
      e.preventDefault()
      cycleChip(1)
      return
    }
    if (mod && e.key === 'ArrowLeft') {
      e.preventDefault()
      cycleChip(-1)
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      if (query) setQuery('')
      else if (attachment) setAttachment(null)
      else void invoke('window:hide')
      return
    }
    // Route stray typing back into the search field.
    if (!mod && !e.altKey && e.key.length === 1 && document.activeElement !== searchInputRef.current) {
      searchInputRef.current?.focus()
    }
  })

  // ── rewrite mini-flow render ──────────────────────────────────────────────
  if (rewrite) {
    const rewriteHints: Array<[string, string]> = rewrite.out
      ? [
          ['↵', 'replace selection'],
          [`${MOD}↵`, 'copy'],
          ['esc', 'back']
        ]
      : [
          ['↵', rewritePrompt.trim() ? 'rewrite' : 'fix typos'],
          ['esc', 'close']
        ]
    return (
      <div className="palette rewrite-mode" data-theme={theme}>
        <div className="rewrite-header">
          <SparkIcon className="action-spark" size={14} />
          <span className="rewrite-title">Rewrite selection</span>
          {running && <span className="rewrite-staging">rewriting…</span>}
          <kbd>esc</kbd>
        </div>
        <div className="rewrite-source">
          <pre className="preview-text dimmed">{rewrite.text}</pre>
        </div>
        {rewrite.out ? (
          <div className="rewrite-result">
            <div className="result-header">
              <SparkIcon className="result-spark" size={13} />
              <span className="result-label" title={rewritePrompt || 'Fix typos'}>
                {rewritePrompt.trim() || 'Fix typos'}
              </span>
              <span className="result-badge">rewritten</span>
            </div>
            <pre className="preview-text result-output">{rewrite.out}</pre>
            <div className="result-actions">
              <button className="btn primary" onClick={() => void applyRewrite()}>
                Replace <kbd>↵</kbd>
              </button>
              <button className="btn" onClick={() => void copyRewrite()}>
                Copy <kbd>{MOD}↵</kbd>
              </button>
              <button className="btn" onClick={() => setRewrite({ ...rewrite, out: null })}>
                Back <kbd>esc</kbd>
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="rewrite-prompt">
              <input
                ref={rewriteInputRef}
                className="rewrite-input"
                value={rewritePrompt}
                onChange={(e) => setRewritePrompt(e.target.value)}
                placeholder="How should it change? (empty ↵ fixes typos)"
                disabled={running}
                spellCheck={false}
              />
            </div>
            <div className="rewrite-fill" />
          </>
        )}
        <div className="footer-bar">
          <div className="footer-hints">
            {rewriteHints.map(([k, label]) => (
              <span key={k} className="hint">
                <kbd>{k}</kbd> {label}
              </span>
            ))}
          </div>
        </div>
        <Toasts toasts={toasts} />
      </div>
    )
  }

  // ── render ────────────────────────────────────────────────────────────────
  const footerHints: Array<[string, string]> = ask
    ? [
        ['↵', askText ? 'ask' : 'paste answer'],
        [`${MOD}↵`, 'copy answer'],
        [`${MOD}D`, micState === 'recording' ? 'stop & review' : 'voice'],
        ['esc', 'back']
      ]
    : sel < 0
      ? [
          ['↵', askText ? `ask${attachment ? ' about clip' : ''}` : attachment ? 'type a question first' : 'paste latest'],
          ['↓', 'history'],
          ['Tab', 'ask about clip'],
          [`${MOD}1-9`, 'quick paste'],
          [`${MOD}/`, 'shortcuts']
        ]
      : [
          ['↵', 'paste'],
          ['⇧↵', 'plain'],
          [`${MOD}↵`, 'copy'],
          ['Tab', 'ask about it'],
          [`${MOD}P`, 'pin'],
          [`${MOD}⌫`, 'delete']
        ]

  return (
    <div className="palette" data-theme={theme}>
      <SearchBar
        value={query}
        onChange={setQuery}
        inputRef={searchInputRef}
        placeholder={
          micState === 'recording'
            ? 'Listening… stop to review, then ↵ to ask'
            : ask
              ? 'Ask something else… (empty ↵ pastes the answer)'
              : attachment
                ? 'Ask about the attached clip…'
                : undefined
        }
        actions={
          <>
            <button
              className={'icon-btn palette-mic ' + micState}
              title={
                micState === 'recording'
                  ? `Stop and review (${MOD}D)`
                  : micState === 'transcribing'
                    ? 'Transcribing…'
                    : `Voice ask (${MOD}D)`
              }
              onClick={() => void toggleMic()}
              tabIndex={-1}
            >
              <MicIcon size={15} />
            </button>
            <button
              className="icon-btn"
              title={`Capture screenshot (${MOD}⇧S)`}
              onClick={() => void captureScreenshot()}
              tabIndex={-1}
            >
              <CameraIcon size={15} />
            </button>
            <button className="icon-btn" title="Settings" onClick={openSettings} tabIndex={-1}>
              <GearIcon size={15} />
            </button>
          </>
        }
      />
      {ask ? (
        <div className="ask-view">
          <div className="ask-thread">
            <div className="agents-msg agents-inbound">
              <div className="agents-msg-body">{ask.question}</div>
              {ask.attachment && (
                <div className="ask-msg-attachment">
                  📎 {(ask.attachment.autoTitle ?? ask.attachment.preview).slice(0, 60)}
                </div>
              )}
            </div>
            {ask.answer && (
              <div className="agents-msg agents-outbound">
                <div className="agents-msg-body">
                  <Markdown text={ask.answer} />
                </div>
              </div>
            )}
            {ask.error && <div className="ask-waiting error">{ask.error}</div>}
            {!ask.done && !ask.answer && (
              <div className="ask-waiting">
                <span className="ask-pulse" />
                thinking…
              </div>
            )}
          </div>
          <div className="ask-actions">
            {ask.done && ask.answer && (
              <>
                <button className="btn primary" onClick={() => void pasteAnswer()}>
                  Paste answer <kbd>↵</kbd>
                </button>
                <button className="btn" onClick={() => void copyAnswer()}>
                  Copy <kbd>{MOD}↵</kbd>
                </button>
              </>
            )}
            <button className="btn" onClick={exitAsk}>
              Back <kbd>esc</kbd>
            </button>
          </div>
        </div>
      ) : (
        <>
          <FilterChips chips={chips} activeId={activeChip.id} onSelect={setActiveChipId} />
          <div className="main-area">
            <div className="list-pane">
              <button
                className={'ask-row' + (sel < 0 ? ' selected' : '')}
                onClick={() => {
                  if (askText) void startAsk()
                  else searchInputRef.current?.focus()
                }}
                tabIndex={-1}
              >
                <SparkIcon className="ask-spark" size={14} />
                {attachment && (
                  <span
                    className="ask-attachment"
                    title={attachment.autoTitle ?? attachment.preview}
                    onClick={(e) => {
                      e.stopPropagation()
                      setAttachment(null)
                    }}
                  >
                    📎 {(attachment.autoTitle ?? attachment.preview).slice(0, 32)}
                    <span className="ask-attachment-x">✕</span>
                  </span>
                )}
                {askText ? (
                  <span className="ask-text">
                    Ask: <em>“{askText}”</em>
                  </span>
                ) : (
                  <span className="ask-text dim">
                    {attachment ? 'Ask about this clip — type or dictate, then ↵' : 'Ask anything — type, then ↵'}
                  </span>
                )}
                <kbd>↵</kbd>
              </button>
              <ItemList
                items={visible}
                pinnedCount={pinnedCount}
                selected={sel}
                onSelect={setSel}
                onPaste={(item) => void pasteItem(item, false)}
              />
            </div>
            <div className="right-pane">
              <PreviewPane item={selectedItem} />
            </div>
          </div>
        </>
      )}
      <div className="footer-bar">
        <div className="footer-hints">
          {footerHints.map(([k, label]) => (
            <span key={k} className="hint">
              <kbd>{k}</kbd> {label}
            </span>
          ))}
        </div>
        <div className="footer-status">
          {searchMode === 'hybrid' && <span className="mode-badge">semantic</span>}
          <span>{total.toLocaleString()} items</span>
        </div>
      </div>
      {showHelp && <HelpOverlay onClose={() => setShowHelp(false)} />}
      <Toasts toasts={toasts} />
    </div>
  )
}
