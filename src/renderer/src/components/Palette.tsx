import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AgentDef,
  AgentMessage,
  AgentSession,
  ClipItem,
  SavedAction,
  SessionInfo,
  SmartCollection,
  PasteOutcome,
  TransformRequest
} from '@shared/types'
import { invoke, on } from '../lib/ipc'
import { fuzzyFilter } from '../lib/fuzzy'
import { blobToB64, configuredMicDeviceId, openMicStream, preferredAudioMime } from '../lib/audio'
import { relTime, sessionLabel } from '../lib/time'
import { MOD } from '../lib/keys'
import { useSearch } from '../hooks/useSearch'
import { useKeymap } from '../hooks/useKeymap'
import { useTheme } from '../hooks/useTheme'
import { useToasts } from '../hooks/useToasts'
import SearchBar from './SearchBar'
import FilterChips, { type Chip } from './FilterChips'
import ItemList from './ItemList'
import PreviewPane, { type TransformView } from './PreviewPane'
import ActionBar from './ActionBar'
import AgentPicker, { targetLabel, type AgentTarget } from './AgentPicker'
import HelpOverlay from './HelpOverlay'
import Markdown from './Markdown'
import Toasts from './Toasts'
import { CameraIcon, GearIcon, MicIcon, PencilIcon, SparkIcon } from './icons'

const KIND_CHIPS: Chip[] = [
  { id: 'all', label: 'All' },
  { id: 'text', label: 'Text', kind: 'text' },
  { id: 'image', label: 'Images', kind: 'image' },
  { id: 'link', label: 'Links', kind: 'link' },
  { id: 'code', label: 'Code', kind: 'code' },
  { id: 'files', label: 'Files', kind: 'files' }
]

type TransformOutput = { output: string; outputKind: 'text' | 'image' }

type Mode =
  | { name: 'normal' }
  | { name: 'action'; item: ClipItem; imageEdit?: boolean }
  | { name: 'agent'; item: ClipItem }
  /** Conversation with the assistant, in place: the answer arrives HERE, not in a
   *  window you have to go find. `askedAt` scopes which messages belong to it;
   *  `showHistory` (↑ on the ask row) shows the whole recent thread instead. */
  | { name: 'ask'; sessionKey: string; askedAt: number; agentName?: string; showHistory?: boolean }
  | { name: 'result'; item: ClipItem; req: TransformRequest; out: TransformOutput; label: string }

/**
 * Selection-rewrite mini-flow. The captured selection has no clip id, so on
 * entry we materialize it via 'scratch:save' and run transforms against that id.
 */
type RewriteState = {
  text: string
  itemId: number | null
  out: (TransformOutput & { label: string }) | null
}

const HIDE_DELAY_MS = 900

export default function Palette() {
  // ── core state ────────────────────────────────────────────────────────────
  const [query, setQuery] = useState('')
  const [activeChipId, setActiveChipId] = useState('all')
  const [collections, setCollections] = useState<SmartCollection[]>([])
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  /**
   * -1 is the "ask assistant" row, and the default: with the input focused, Enter
   * asks the assistant. Arrowing down moves into clipboard history, where every
   * key behaves exactly as it always has.
   */
  const [sel, setSel] = useState(-1)
  const [mode, setMode] = useState<Mode>({ name: 'normal' })
  const [rewrite, setRewrite] = useState<RewriteState | null>(null)
  const [actions, setActions] = useState<SavedAction[]>([])
  const [actionInput, setActionInput] = useState('')
  const [actionHighlight, setActionHighlight] = useState(0)
  const [agentTargets, setAgentTargets] = useState<AgentTarget[]>([])
  const [agentInput, setAgentInput] = useState('')
  const [agentHighlight, setAgentHighlight] = useState(0)
  const [askThread, setAskThread] = useState<AgentMessage[]>([])
  const [agentDefs, setAgentDefs] = useState<AgentDef[]>([])
  /** Sticky ask target (⇧Tab cycles it); null = the primary. */
  const [askTarget, setAskTarget] = useState<string | null>(null)
  /** Clip riding along with the next ask — same ask box, with context. */
  const [attachment, setAttachment] = useState<ClipItem | null>(null)
  const [micState, setMicState] = useState<'idle' | 'recording' | 'transcribing'>('idle')
  const [showHelp, setShowHelp] = useState(false)
  const [running, setRunning] = useState(false)
  const [shownTick, setShownTick] = useState(0)
  const { toasts, addToast } = useToasts()
  const theme = useTheme()

  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const actionInputRef = useRef<HTMLInputElement | null>(null)
  const agentInputRef = useRef<HTMLInputElement | null>(null)
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
  const sessionChips = useMemo<Chip[]>(
    () =>
      sessions.map((s) => ({
        id: `ses:${s.id}`,
        label: sessionLabel(s),
        collection: `session:${s.id}`,
        count: s.count
      })),
    [sessions]
  )
  const allChips = useMemo(() => [...chips, ...sessionChips], [chips, sessionChips])
  const activeChip = allChips.find((c) => c.id === activeChipId) ?? allChips[0]

  // ── ask target: sticky (⇧Tab) or @mention for one ask ─────────────────────
  const persistentAgents = useMemo(
    () => agentDefs.filter((d) => d.persistent !== false),
    [agentDefs]
  )
  /** `@stu how do I…` targets the studio agent for this ask; the prefix is
   *  stripped from both the search and the sent text. */
  const mention = useMemo(() => {
    const m = /^@(\S*)(?:\s+([\s\S]*))?$/.exec(query)
    if (!m) return null
    const frag = m[1].toLowerCase()
    const def =
      persistentAgents.find((d) => d.name.toLowerCase() === frag) ??
      persistentAgents.find((d) => frag.length > 0 && d.name.toLowerCase().startsWith(frag)) ??
      null
    return def ? { def, text: (m[2] ?? '').trim() } : null
  }, [query, persistentAgents])

  const targetAgent: AgentDef | null =
    mention?.def ??
    persistentAgents.find((d) => d.name === askTarget) ??
    persistentAgents[0] ??
    null
  /** What would actually be asked (mention prefix stripped). */
  const askText = (mention ? mention.text : query).trim()
  /** What the list should filter by — a mention prefix is not a search term. */
  const searchQuery = mention ? mention.text : query

  const cycleAgent = useCallback(() => {
    if (persistentAgents.length < 2) return
    const current = targetAgent?.name
    const idx = persistentAgents.findIndex((d) => d.name === current)
    setAskTarget(persistentAgents[(idx + 1) % persistentAgents.length].name)
  }, [persistentAgents, targetAgent])

  /** The @token still being typed (no space yet) — drives the autocomplete. */
  const mentionTyping = useMemo(() => {
    const m = /^@(\S*)$/.exec(query)
    if (!m) return null
    const frag = m[1].toLowerCase()
    const candidates = persistentAgents.filter((d) => d.name.toLowerCase().startsWith(frag))
    return candidates.length > 0 ? { frag, candidates } : null
  }, [query, persistentAgents])
  const [mentionHighlight, setMentionHighlight] = useState(0)
  useEffect(() => setMentionHighlight(0), [query])

  const completeMention = useCallback(
    (def: AgentDef) => {
      setQuery(`@${def.name} `)
      searchInputRef.current?.focus()
    },
    []
  )

  // ── search ────────────────────────────────────────────────────────────────
  const { items, total, searchMode, refresh } = useSearch(
    searchQuery,
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
  const previewItem =
    mode.name === 'normal' || mode.name === 'ask' ? selectedItem : mode.item

  // Typing recomposes the ask/search — selection returns to the ask row. Arrowing
  // back into the (re-filtered) list is one keystroke.
  useEffect(() => setSel(-1), [query, activeChipId])
  useEffect(() => {
    setSel((s) => (s < 0 ? s : visible.length === 0 ? -1 : Math.min(s, visible.length - 1)))
  }, [visible.length])

  // ── collections + sessions ────────────────────────────────────────────────
  const loadCollections = useCallback(() => {
    invoke('collections:list')
      .then(setCollections)
      .catch(() => {})
    invoke('sessions:list')
      .then(setSessions)
      .catch(() => {})
    invoke('agents:defs')
      .then(setAgentDefs)
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
    // Smart collections live in settings — re-pull the (counted) list whenever
    // settings change anywhere, so edits in the Settings window land live here.
    const offSettings = on('settings:changed', () => loadCollections())
    const offShown = on('palette:shown', (p) => {
      setMode({ name: 'normal' })
      setQuery('')
      setSel(-1)
      setActionInput('')
      setActionHighlight(0)
      setAgentInput('')
      setAgentHighlight(0)
      setAskThread([])
      setAttachment(null)
      setShowHelp(false)
      if (p.mode === 'rewrite' && p.rewriteText) {
        // Rewrite mini-flow: materialize the selection as a clip so transforms
        // (which need an itemId) can run against it.
        const text = p.rewriteText
        setRewrite({ text, itemId: null, out: null })
        invoke('actions:list', 'text')
          .then(setActions)
          .catch(() => setActions([]))
        invoke('scratch:save', { text })
          .then((id) => setRewrite((r) => (r && r.text === text ? { ...r, itemId: id } : r)))
          .catch(() => addToast('Could not stage the selection', 'error'))
      } else {
        setRewrite(null)
        setActiveChipId(
          p.collection ? (p.collection === 'pinned' ? 'pinned' : `col:${p.collection}`) : 'all'
        )
      }
      setShownTick((t) => t + 1)
    })
    return () => {
      offItems()
      offToast()
      offShown()
      offSettings()
    }
  }, [addToast, loadCollections])

  // ── focus management ──────────────────────────────────────────────────────
  useEffect(() => {
    if (rewrite) {
      if (rewrite.out) (document.activeElement as HTMLElement | null)?.blur()
      else actionInputRef.current?.focus()
      return
    }
    if (mode.name === 'normal' || mode.name === 'ask') {
      searchInputRef.current?.focus()
    } else if (mode.name === 'action') {
      actionInputRef.current?.focus()
    } else if (mode.name === 'agent') {
      agentInputRef.current?.focus()
    } else {
      ;(document.activeElement as HTMLElement | null)?.blur()
    }
  }, [mode.name, shownTick, rewrite])

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

  const togglePin = useCallback(
    async (item: ClipItem) => {
      await invoke('item:pin', item.id, !item.pinned).catch(() => {})
      void refreshRef.current()
    },
    []
  )

  const deleteItem = useCallback(
    async (item: ClipItem) => {
      await invoke('item:delete', item.id).catch(() => {})
      void refreshRef.current()
    },
    []
  )

  // From the ask row, Tab/⌘J/⌘N act on the first item — the nearest thing on screen.
  const actionTarget = useCallback(
    (): ClipItem | null => (sel >= 0 ? (visible[sel] ?? null) : (visible[0] ?? null)),
    [visible, sel]
  )

  // ── ask the assistant ─────────────────────────────────────────────────────
  /** Local optimistic entry — the bridge only records a message once delivered,
   *  which can lag many seconds; the user's own words must appear instantly. */
  const localMsg = (sessionKey: string, body: string): AgentMessage => ({
    id: -Date.now(),
    sessionKey,
    direction: 'inbound',
    kind: 'message',
    body,
    createdAt: Date.now(),
    readAt: null
  })

  const askAssistant = useCallback(
    async (textArg?: string, attachOverride?: ClipItem) => {
      const text = (textArg ?? askText).trim()
      if (!text || runningRef.current) return
      const attach = attachOverride ?? attachment
      runningRef.current = true
      setRunning(true)
      try {
        if (mode.name === 'ask') {
          // Follow-up into the same conversation. agents:send queues a background
          // retry when the session is still waking, so false means truly gone.
          const ok = await invoke('agents:send', mode.sessionKey, text, 'message')
          if (!ok) {
            addToast('That agent session has ended — Esc and ask again', 'error')
            return
          }
          setAskThread((t) => [...t, localMsg(mode.sessionKey, text)])
          setQuery('')
        } else {
          // Clock the ask BEFORE the round-trip: the reply can only be newer than
          // the question, and this stamp is what scopes the thread — a lookback
          // window here once showed the PREVIOUS answer as the new one.
          const askedAt = Date.now()
          const res = await invoke('agents:ask', text, targetAgent?.name, attach?.id)
          // The optimistic entry mirrors the server's <attached-clip> shape so the
          // thread renderer collapses both into the same chip.
          const shown = attach
            ? `${text}\n\n<attached-clip>\n${attach.autoTitle ?? attach.preview.slice(0, 60)}\n</attached-clip>`
            : text
          setAskThread([localMsg(res.key, shown)])
          setMode({ name: 'ask', sessionKey: res.key, askedAt, agentName: targetAgent?.name })
          setQuery('')
          setAttachment(null)
        }
      } catch (err) {
        addToast(err instanceof Error ? err.message : 'Could not reach the agent', 'error')
      } finally {
        runningRef.current = false
        setRunning(false)
      }
    },
    [askText, targetAgent, attachment, mode, addToast]
  )

  // Poll the conversation while ask mode is up. The reply is written to SQLite by
  // the Stop hook / bridge from OUTSIDE this process, so polling is the honest way
  // to see it; 1s is imperceptible against a model turn.
  useEffect(() => {
    if (mode.name !== 'ask') return
    const key = mode.sessionKey
    // Strictly >= askedAt: a grace window here pulled the previous exchange's
    // answer into a new ask. The question itself renders from the optimistic
    // local entry, so excluding its slightly-earlier server row costs nothing.
    // A deliberately REOPENED conversation (↑) is the exception — there, the
    // history is the point.
    const since = mode.showHistory ? 0 : mode.askedAt
    let cancelled = false
    const tick = async (): Promise<void> => {
      // A hidden palette must not consume the conversation: mark-read from an
      // invisible window would silence the tray badge for a reply nobody saw.
      if (document.hidden) return
      try {
        const msgs = await invoke('agents:messages', key)
        if (cancelled) return
        const server = msgs.filter((m) => m.createdAt >= since).slice(-40)
        setAskThread((local) => {
          // Server wins; keep only optimistic entries the server hasn't echoed yet.
          // Matched on the QUESTION part: an attached ask's server body carries the
          // full clip context while the optimistic one carries only a chip label.
          const qOf = (b: string): string => b.split('<attached-clip>')[0].trim()
          const seen = new Set(
            server.filter((m) => m.direction === 'inbound').map((m) => qOf(m.body))
          )
          const pending = local.filter((m) => m.id < 0 && !seen.has(qOf(m.body)))
          return [...server, ...pending].sort((a, b) => a.createdAt - b.createdAt)
        })
        if (server.some((m) => m.direction === 'outbound' && m.readAt === null)) {
          void invoke('agents:mark-read', key)
        }
      } catch {
        /* window closing */
      }
    }
    void tick()
    const t = setInterval(() => void tick(), 1000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [mode])

  // 'failure' is a delivery report and 'progress' is status chatter — pasting
  // either as "the answer" would put diagnostics into the user's document.
  const latestAnswer = useMemo(
    () =>
      [...askThread]
        .reverse()
        .find(
          (m) => m.direction === 'outbound' && m.kind !== 'failure' && m.kind !== 'progress'
        ) ?? null,
    [askThread]
  )
  /** Waiting when the newest message is ours. */
  const askWaiting =
    askThread.length > 0 && askThread[askThread.length - 1].direction === 'inbound'

  const askBottomRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    askBottomRef.current?.scrollIntoView({ block: 'end' })
  }, [askThread.length])

  const pasteAnswer = useCallback(async () => {
    if (!latestAnswer) return
    try {
      handleOutcome(
        await invoke('transform:paste-output', { output: latestAnswer.body, outputKind: 'text' })
      )
    } catch {
      addToast('Paste failed', 'error')
    }
  }, [latestAnswer, handleOutcome, addToast])

  const copyAnswer = useCallback(async () => {
    if (!latestAnswer) return
    try {
      await navigator.clipboard.writeText(latestAnswer.body)
      addToast('Answer copied', 'success')
    } catch {
      addToast('Copy failed', 'error')
    }
  }, [latestAnswer, addToast])

  const exitAsk = useCallback(() => {
    setMode({ name: 'normal' })
    setAskThread([])
  }, [])

  /** ↑ on the ask row: reopen the last conversation with the current agent —
   *  the chat reflex for "where did that answer go". */
  const resumeConversation = useCallback(async () => {
    try {
      const key = await invoke('agents:session-for', targetAgent?.name)
      if (!key) {
        addToast(`No conversation with @${targetAgent?.name ?? 'the agent'} yet — just ask`, 'info')
        return
      }
      setAskThread([])
      setMode({
        name: 'ask',
        sessionKey: key,
        askedAt: Date.now(),
        agentName: targetAgent?.name,
        showHistory: true
      })
    } catch {
      addToast('Could not open the conversation', 'error')
    }
  }, [targetAgent, addToast])

  // ── voice ask (mic → transcribe → INPUT, never auto-sent) ─────────────────
  const recRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const micStreamRef = useRef<MediaStream | null>(null)

  /**
   * Dictated text lands in the input box for review — Enter sends it. Auto-
   * submitting shipped half-finished sentences the moment the key was released
   * (John hit exactly that), and a mis-transcription went to the agent with no
   * chance to fix it. Appends after anything already typed, so "@studio " +
   * dictation composes naturally.
   */
  /**
   * Put a transcript where the user is actually typing.
   *
   * This used to append to `query` and pull focus to the search box unconditionally,
   * so dictating into any OTHER field in the palette — the image-edit prompt, an
   * action's input — silently delivered the words to the launcher instead, and moved
   * the caret out of the field you were in.
   *
   * The focused element is the honest answer to "where should this go". Writing to a
   * React-controlled input needs the native value setter plus an input event, or the
   * component's state never learns about the change and the text vanishes on the next
   * render.
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
   *  guard, a repeated ⌘D opens N streams and only the last ever gets stopped —
   *  the OS mic indicator then stays lit until the window reloads. */
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

  /** Abandon any in-flight recording without transcribing (palette re-shown). */
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

  // Hold-to-talk finished while the palette was open: the transcript belongs in
  // the ask input, not pasted into the app underneath (main routes it here — see
  // ipc.ts) and NOT auto-sent — you read it, then hit Enter.
  useEffect(() => {
    return on('palette:dictation', (p) => insertRef.current(p.text))
  }, [])

  // ── send to agent ─────────────────────────────────────────────────────────
  // `explicit` pins the clip (the action panel passes its mode.item): the visible
  // list can shift under an open panel when a background capture lands, and
  // re-deriving from sel would then act on the wrong clip.
  const enterAgentMode = useCallback(async (explicit?: ClipItem) => {
    const item = explicit ?? actionTarget()
    if (!item) return
    if (item.secret) {
      addToast('Secret clips are never sent to agents', 'error')
      return
    }
    if (!explicit && sel < 0) setSel(0)
    try {
      const [sessions, profiles] = await Promise.all([
        invoke('agents:sessions', false),
        invoke('agents:profiles')
      ])
      // Reachable-and-active first, dormant after (they wake on send), newest first.
      const rank = (s: AgentSession): number => (s.status === 'dormant' ? 1 : s.reachable ? 0 : 2)
      const ordered = [...sessions].sort(
        (a, b) => rank(a) - rank(b) || b.lastSeenAt - a.lastSeenAt
      )
      setAgentTargets([
        ...ordered.map((session) => ({ type: 'session', session }) as AgentTarget),
        ...profiles.map((profile) => ({ type: 'new', profile }) as AgentTarget)
      ])
    } catch {
      setAgentTargets([])
    }
    setAgentInput('')
    setAgentHighlight(0)
    setMode({ name: 'agent', item })
  }, [actionTarget, sel, addToast])

  const filteredTargets = useMemo(
    () => fuzzyFilter(agentTargets, agentInput, targetLabel),
    [agentTargets, agentInput]
  )

  useEffect(() => {
    setAgentHighlight((h) =>
      filteredTargets.length === 0 ? 0 : Math.min(h, filteredTargets.length - 1)
    )
  }, [filteredTargets.length])

  const pickAgentTarget = useCallback(
    async (item: ClipItem, target: AgentTarget) => {
      if (runningRef.current) return
      runningRef.current = true
      setRunning(true)
      try {
        if (target.type === 'session') {
          const ok = await invoke('agents:send-clip', target.session.key, item.id)
          if (!ok) {
            addToast('Could not reach that session — it may have exited', 'error')
            return
          }
          addToast(`Sent to ${targetLabel(target)} — replies land in the inbox`, 'success')
        } else {
          await invoke('agents:launch-with-clip', { profile: target.profile.name, itemId: item.id })
          addToast(`Started a ${target.profile.name} session with the clip`, 'success')
        }
        setMode({ name: 'normal' })
        hideSoon()
      } catch (err) {
        addToast(err instanceof Error ? err.message : 'Send failed', 'error')
      } finally {
        runningRef.current = false
        setRunning(false)
      }
    },
    [addToast, hideSoon]
  )

  // ── new note from clip ────────────────────────────────────────────────────
  const noteFromClip = useCallback(async (explicit?: ClipItem) => {
    const item = explicit ?? actionTarget()
    // A secret or binary clip makes a blank note rather than nothing: ⌘N always
    // gives you a note.
    const textual = item && !item.secret && item.kind !== 'image' && item.kind !== 'files'
    try {
      // List rows carry previews; the note wants the clip's FULL text.
      const full = textual ? await invoke('item:get', item.id) : null
      const id = await invoke('notes:create', full ? { content: full.content } : {})
      await invoke('window:open-notes', id)
    } catch {
      addToast('Could not create the note', 'error')
    }
  }, [actionTarget, addToast])

  // ── action mode ───────────────────────────────────────────────────────────
  /**
   * Navigation pseudo-actions, appended to the action list so everything a direct
   * shortcut does is also findable by typing in the panel (the Raycast rule that
   * makes shortcuts learnable). Intercepted by id in runSavedAction — they change
   * mode instead of running a transform.
   */
  /** Pinned FIRST: asking an agent about the entry is the headline action (John's
   *  call) — the rest of the list keeps its shipped order below it. */
  const ASK_CLIP_ACTION: SavedAction = useMemo(
    () => ({
      id: 'x-ask-clip',
      title: `Ask @${targetAgent?.name ?? 'agent'} about this…`,
      key: 'a',
      type: 'builtin',
      appliesTo: ['text', 'image']
    }),
    [targetAgent]
  )

  const PSEUDO_ACTIONS: SavedAction[] = useMemo(
    () => [
      { id: 'x-img-edit', title: 'Edit image with AI…', key: 'e', type: 'builtin', appliesTo: ['image'] },
      { id: 'x-send-agent', title: 'Send to agent session…', type: 'builtin', appliesTo: ['text', 'image'] },
      { id: 'x-new-note', title: 'New note from clip', key: 'n', type: 'builtin', appliesTo: ['text', 'image'] }
    ],
    []
  )

  const enterActionMode = useCallback(async () => {
    const item = actionTarget()
    if (!item) return
    if (sel < 0) setSel(0)
    try {
      // Keep the 'actions:list' order verbatim (never alphabetize): the
      // interesting AI actions come first by design.
      const kind = item.kind === 'image' ? 'image' : 'text'
      const list = await invoke('actions:list', kind)
      const pseudo = PSEUDO_ACTIONS.filter((a) => a.appliesTo.includes(kind))
      // For images, editing sits right under asking — the two headline verbs —
      // not below a scroll of format converters.
      const imgEdit = pseudo.filter((a) => a.id === 'x-img-edit')
      const rest = pseudo.filter((a) => a.id !== 'x-img-edit')
      setActions([ASK_CLIP_ACTION, ...imgEdit, ...list, ...rest])
    } catch {
      setActions([ASK_CLIP_ACTION, ...PSEUDO_ACTIONS])
    }
    setActionInput('')
    // Empty input → the first action is preselected.
    setActionHighlight(0)
    setMode({ name: 'action', item })
  }, [actionTarget, sel, ASK_CLIP_ACTION, PSEUDO_ACTIONS])

  const filteredActions = useMemo(
    () => fuzzyFilter(actions, actionInput, (a) => a.title),
    [actions, actionInput]
  )

  useEffect(() => {
    setActionHighlight((h) =>
      filteredActions.length === 0 ? 0 : Math.min(h, filteredActions.length - 1)
    )
  }, [filteredActions.length])

  const runTransform = useCallback(
    async (item: ClipItem, req: TransformRequest, label: string) => {
      if (runningRef.current) return
      runningRef.current = true
      setRunning(true)
      try {
        const res = await invoke('transform:run', req)
        if (!res.ok || res.output == null) {
          addToast(res.error ?? 'Transform failed', 'error')
          return
        }
        setMode({
          name: 'result',
          item,
          req,
          label,
          out: {
            output: res.output,
            outputKind: res.outputKind ?? (item.kind === 'image' ? 'image' : 'text')
          }
        })
      } catch {
        addToast('Transform failed', 'error')
      } finally {
        runningRef.current = false
        setRunning(false)
      }
    },
    [addToast]
  )

  const runSavedAction = useCallback(
    (item: ClipItem, action: SavedAction) => {
      if (action.id === 'x-ask-clip') {
        // Back to the ordinary ask box — with the clip riding along as a chip.
        if (item.secret) {
          addToast('Secret clips are never sent to agents', 'error')
          return
        }
        setAttachment(item)
        setMode({ name: 'normal' })
        setSel(-1)
        setQuery('')
        return
      }
      if (action.id === 'x-img-edit') {
        // Same panel, different verb: the input becomes an edit instruction and
        // the result comes back as a new image (preview → paste, as ever).
        setActionInput('')
        setActionHighlight(0)
        setMode({ name: 'action', item, imageEdit: true })
        return
      }
      if (action.id === 'x-send-agent') {
        void enterAgentMode(item)
        return
      }
      if (action.id === 'x-new-note') {
        void noteFromClip(item)
        return
      }
      void runTransform(item, { itemId: item.id, actionId: action.id }, action.title)
    },
    [runTransform, enterAgentMode, noteFromClip, addToast]
  )

  const runActionEnter = useCallback(
    (item: ClipItem) => {
      if (filteredActions.length > 0) {
        const a = filteredActions[actionHighlight] ?? filteredActions[0]
        runSavedAction(item, a)
      } else if (actionInput.trim()) {
        const prompt = actionInput.trim()
        void runTransform(item, { itemId: item.id, freePrompt: prompt }, prompt)
      }
    },
    [filteredActions, actionHighlight, actionInput, runSavedAction, runTransform]
  )

  const pasteResult = useCallback(
    async (m: Extract<Mode, { name: 'result' }>, plain: boolean) => {
      // Commit is fire-and-forget: the derived clip lands in history either way.
      void invoke('transform:commit', {
        ...m.req,
        output: m.out.output,
        outputKind: m.out.outputKind
      }).catch(() => {})
      try {
        handleOutcome(await invoke('transform:paste-output', { ...m.out, plain }))
      } catch {
        addToast('Paste failed', 'error')
      }
    },
    [handleOutcome, addToast]
  )

  const copyResult = useCallback(
    async (m: Extract<Mode, { name: 'result' }>) => {
      try {
        const derivedId = await invoke('transform:commit', {
          ...m.req,
          output: m.out.output,
          outputKind: m.out.outputKind
        })
        await invoke('item:copy', derivedId)
        addToast('Result copied to clipboard', 'success')
        hideSoon()
      } catch {
        addToast('Copy failed', 'error')
      }
    },
    [addToast, hideSoon]
  )

  // ── screenshot / scratchpad / settings entry points ───────────────────────
  const captureScreenshot = useCallback(async () => {
    try {
      const res = await invoke('capture:screenshot')
      if (res.ok) addToast('Captured to history', 'success')
      else addToast(res.error ?? 'Screenshot cancelled', 'error')
    } catch {
      addToast('Screenshot failed', 'error')
    }
  }, [addToast])

  const openScratchpad = useCallback(() => {
    // Effective item: the top match while the ask row is selected, like every
    // other item-targeting shortcut.
    const item = actionTarget()
    // Only hand over textual clips: images/files/secrets open a blank pad.
    const textual = item && !item.secret && item.kind !== 'image' && item.kind !== 'files'
    void invoke('window:open-scratchpad', textual ? item.id : undefined).catch(() => {})
  }, [actionTarget])

  const openSettings = useCallback(() => {
    void invoke('window:open-settings').catch(() => {})
  }, [])

  // ── rewrite mini-flow ─────────────────────────────────────────────────────
  const runRewrite = useCallback(
    async (partial: { actionId?: string; freePrompt?: string }, label: string) => {
      if (!rewrite) return
      if (rewrite.itemId == null) {
        addToast('Still staging the selection — try again in a moment', 'info')
        return
      }
      const itemId = rewrite.itemId
      if (runningRef.current) return
      runningRef.current = true
      setRunning(true)
      try {
        const res = await invoke('transform:run', { itemId, ...partial })
        if (!res.ok || res.output == null) {
          addToast(res.error ?? 'Transform failed', 'error')
          return
        }
        const output = res.output
        const outputKind = res.outputKind ?? 'text'
        // Fire-and-forget commit so the rewrite lands in history as a derived clip.
        void invoke('transform:commit', { itemId, ...partial, output, outputKind }).catch(() => {})
        setRewrite((r) => (r ? { ...r, out: { output, outputKind, label } } : r))
      } catch {
        addToast('Transform failed', 'error')
      } finally {
        runningRef.current = false
        setRunning(false)
      }
    },
    [rewrite, addToast]
  )

  const applyRewrite = useCallback(async () => {
    const out = rewrite?.out
    if (!out) return
    try {
      const outcome = await invoke('rewrite:apply', { output: out.output })
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

  /** One step back from the rewrite result to the action list (result stays committed to history). */
  const backRewrite = useCallback(() => {
    setRewrite((r) => (r ? { ...r, out: null } : r))
  }, [])

  const copyRewrite = useCallback(async () => {
    const out = rewrite?.out
    if (!out) return
    try {
      await navigator.clipboard.writeText(out.output)
      addToast('Result copied to clipboard', 'success')
      hideSoon()
    } catch {
      addToast('Copy failed', 'error')
    }
  }, [rewrite, addToast, hideSoon])

  const exitRewrite = useCallback(() => {
    setRewrite(null)
    void invoke('window:hide')
  }, [])

  // ── chip cycling ──────────────────────────────────────────────────────────
  const cycleKind = useCallback(() => {
    const idx = KIND_CHIPS.findIndex((c) => c.id === activeChipId)
    setActiveChipId(KIND_CHIPS[(idx + 1) % KIND_CHIPS.length].id)
  }, [activeChipId])

  const cycleChip = useCallback(
    (dir: 1 | -1) => {
      const idx = allChips.findIndex((c) => c.id === activeChipId)
      const next = (idx + dir + allChips.length) % allChips.length
      setActiveChipId(allChips[next].id)
    },
    [allChips, activeChipId]
  )

  // ── keyboard model ────────────────────────────────────────────────────────
  useKeymap((e) => {
    const mod = e.ctrlKey || e.metaKey

    // Screenshot works from any palette mode.
    if (mod && e.shiftKey && e.key.toLowerCase() === 's') {
      e.preventDefault()
      void captureScreenshot()
      return
    }

    // Shortcut cheat sheet: toggle from any mode except the rewrite mini-flow,
    // whose early-return render has nowhere to show it.
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
        // Step back one level: result → action list → close.
        if (rewrite.out) backRewrite()
        else exitRewrite()
        return
      }
      if (running) return
      if (rewrite.out) {
        if (e.key === 'Enter' && mod) {
          e.preventDefault()
          void copyRewrite()
        } else if (e.key === 'Enter') {
          e.preventDefault()
          void applyRewrite()
        }
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        if (filteredActions.length > 0) {
          const a = filteredActions[actionHighlight] ?? filteredActions[0]
          void runRewrite({ actionId: a.id }, a.title)
        } else if (actionInput.trim()) {
          const prompt = actionInput.trim()
          void runRewrite({ freePrompt: prompt }, prompt)
        }
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActionHighlight((h) => Math.min(h + 1, Math.max(0, filteredActions.length - 1)))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActionHighlight((h) => Math.max(h - 1, 0))
      } else if (!actionInput && !mod && !e.altKey && e.key.length === 1) {
        const bound = actions.find((a) => a.key && a.key.toLowerCase() === e.key.toLowerCase())
        if (bound) {
          e.preventDefault()
          void runRewrite({ actionId: bound.id }, bound.title)
        }
      }
      return
    }

    if (mode.name === 'result') {
      if (e.key === 'Escape') {
        e.preventDefault()
        setMode({ name: 'action', item: mode.item })
      } else if (e.key === 'Enter' && mod) {
        e.preventDefault()
        void copyResult(mode)
      } else if (e.key === 'Enter') {
        e.preventDefault()
        void pasteResult(mode, e.shiftKey)
      }
      return
    }

    // Mic toggle, wherever asking is possible. `repeat` filtered: holding ⌘D
    // auto-repeats, and a repeat landing after the recorder starts would stop it.
    if (
      mod &&
      e.key.toLowerCase() === 'd' &&
      !e.repeat &&
      (mode.name === 'normal' || mode.name === 'ask') &&
      !rewrite
    ) {
      e.preventDefault()
      void toggleMic()
      return
    }

    if (mode.name === 'ask') {
      if (e.key === 'Escape') {
        e.preventDefault()
        exitAsk()
        return
      }
      // ↑ with an empty box: reveal the rest of the conversation, in place.
      if (e.key === 'ArrowUp' && !mod && !query.trim() && !mode.showHistory) {
        e.preventDefault()
        setMode({ ...mode, showHistory: true })
        return
      }
      if (e.key === 'Enter' && mod) {
        e.preventDefault()
        void copyAnswer()
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        // Typed text is a follow-up; an empty box pastes the answer.
        if (query.trim()) void askAssistant()
        else void pasteAnswer()
        return
      }
      // Everything else (typing, arrows for scroll) belongs to the input/thread.
      if (
        !mod &&
        !e.altKey &&
        e.key.length === 1 &&
        document.activeElement !== searchInputRef.current
      ) {
        searchInputRef.current?.focus()
      }
      return
    }

    if (mode.name === 'agent') {
      if (e.key === 'Escape') {
        e.preventDefault()
        setMode({ name: 'normal' })
        return
      }
      if (running) return
      if (e.key === 'Enter') {
        e.preventDefault()
        const t = filteredTargets[agentHighlight] ?? filteredTargets[0]
        if (t) void pickAgentTarget(mode.item, t)
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        setAgentHighlight((h) => Math.min(h + 1, Math.max(0, filteredTargets.length - 1)))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setAgentHighlight((h) => Math.max(h - 1, 0))
      }
      return
    }

    if (mode.name === 'action') {
      if (e.key === 'Escape') {
        e.preventDefault()
        setMode({ name: 'normal' })
        return
      }
      if (running) return
      // Two submit verbs on the free-prompt box: Enter = one-shot transform (a
      // pasteable result), ⌘Enter = ask the agent this ABOUT the clip — the
      // conversational lane, clip context attached.
      if (e.key === 'Enter' && mod && actionInput.trim()) {
        e.preventDefault()
        if (mode.item.secret) {
          addToast('Secret clips are never sent to agents', 'error')
          return
        }
        void askAssistant(actionInput.trim(), mode.item)
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        if (mode.imageEdit) {
          const p = actionInput.trim()
          if (p) {
            void runTransform(
              mode.item,
              { itemId: mode.item.id, freePrompt: p, imageEdit: true },
              `Edit: ${p}`
            )
          }
          return
        }
        runActionEnter(mode.item)
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActionHighlight((h) => Math.min(h + 1, Math.max(0, filteredActions.length - 1)))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActionHighlight((h) => Math.max(h - 1, 0))
      } else if (!mode.imageEdit && !actionInput && !mod && !e.altKey && e.key.length === 1) {
        // Single-key saved-action bindings fire only while the input is empty.
        const bound = actions.find((a) => a.key && a.key.toLowerCase() === e.key.toLowerCase())
        if (bound) {
          e.preventDefault()
          runSavedAction(mode.item, bound)
        }
      }
      return
    }

    // ── normal mode ──
    // A half-typed @mention owns the navigation keys: the popup completes with
    // Tab/Enter and moves with ↓↑, Raycast-style.
    if (mentionTyping && !mod && !e.shiftKey) {
      const picked = mentionTyping.candidates[mentionHighlight] ?? mentionTyping.candidates[0]
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setMentionHighlight((h) => Math.min(h + 1, mentionTyping.candidates.length - 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setMentionHighlight((h) => Math.max(h - 1, 0))
        return
      }
      if (e.key === 'Tab' || e.key === 'Enter') {
        e.preventDefault()
        completeMention(picked)
        return
      }
    }
    // ⇧Tab retargets the ask row; Tab and ⌘K open the action panel (⌘K for the
    // Raycast/Linear reflex).
    if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault()
      cycleAgent()
      return
    }
    if (e.key === 'Tab' || (mod && e.key.toLowerCase() === 'k')) {
      e.preventDefault()
      void enterActionMode()
      return
    }
    if (mod && e.key.toLowerCase() === 'j') {
      e.preventDefault()
      void enterAgentMode()
      return
    }
    if (mod && e.key.toLowerCase() === 'n') {
      e.preventDefault()
      void noteFromClip()
      return
    }
    if (e.key === 'ArrowDown' && !mod) {
      e.preventDefault()
      setSel((s) => Math.min(s + 1, Math.max(-1, visible.length - 1)))
      return
    }
    if (e.key === 'ArrowUp' && !mod) {
      e.preventDefault()
      // Above the first item sits the ask row — and above THAT, like every chat
      // input, sits the previous conversation.
      if (sel === -1) void resumeConversation()
      else setSel((s) => Math.max(s - 1, -1))
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      if (sel < 0) {
        // The ask row: Enter hands the typed text to the targeted agent.
        // A bare "@name" (mention, no text yet) does nothing. With nothing
        // typed at all there is nothing to ask — fall through to the first
        // item, honouring the same modifiers as an explicit selection
        // (mod+Enter must still COPY; regressing it to paste injected keys
        // into whatever app had focus).
        if (askText) {
          void askAssistant()
          return
        }
        // An attachment (or bare @mention) without a question is not "paste
        // latest" — it's a half-composed ask.
        if (mention || attachment) return
        if (!visible[0]) return
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
    // selected. With the ask-first default, requiring an explicit selection made
    // these SILENT no-ops in exactly the state they were most used from (type a
    // filter, ⌘⌫ the sensitive clip — which then quietly survived).
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
    if (mod && e.key.toLowerCase() === 'e') {
      e.preventDefault()
      openScratchpad()
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

  // ── render ────────────────────────────────────────────────────────────────
  const resultView: TransformView | null =
    mode.name === 'result'
      ? { output: mode.out.output, outputKind: mode.out.outputKind, label: mode.label }
      : null

  const footerHints: Array<[string, string]> =
    mode.name === 'normal'
      ? sel < 0
        ? [
            [
              '↵',
              askText
                ? `ask ${targetAgent?.name ?? 'assistant'}${attachment ? ' about clip' : ''}`
                : attachment
                  ? 'type a question first'
                  : 'paste latest'
            ],
            ...(persistentAgents.length > 1 ? ([['⇧Tab', 'agent']] as Array<[string, string]>) : []),
            ['↑', 'last convo'],
            ['↓', 'history'],
            ['Tab', 'actions'],
            [`${MOD}1-9`, 'quick paste'],
            [`${MOD}/`, 'shortcuts']
          ]
        : [
            ['↵', 'paste'],
            ['⇧↵', 'plain'],
            [`${MOD}↵`, 'copy'],
            ['Tab', 'actions'],
            [`${MOD}J`, 'agent'],
            [`${MOD}N`, 'note'],
            [`${MOD}P`, 'pin'],
            [`${MOD}⌫`, 'delete']
          ]
      : mode.name === 'ask'
        ? [
            ['↵', query.trim() ? 'send follow-up' : 'paste answer'],
            ...(!mode.showHistory ? ([['↑', 'history']] as Array<[string, string]>) : []),
            [`${MOD}↵`, 'copy answer'],
            [`${MOD}D`, micState === 'recording' ? 'stop & review' : 'voice'],
            ['esc', 'back']
          ]
        : mode.name === 'action'
          ? mode.imageEdit
            ? [
                ['↵', 'edit image'],
                ['esc', 'back']
              ]
            : [
                ['↵', 'run'],
                ['↑↓', 'choose'],
                ['key', 'instant action'],
                ['esc', 'back']
              ]
          : mode.name === 'agent'
            ? [
                ['↵', 'send'],
                ['↑↓', 'choose'],
                ['esc', 'back']
              ]
            : [
                ['↵', 'paste result'],
                ['⇧↵', 'paste plain'],
                [`${MOD}↵`, 'copy result'],
                ['esc', 'back']
              ]

  // ── rewrite mini-flow render ──────────────────────────────────────────────
  if (rewrite) {
    const rewriteHints: Array<[string, string]> = rewrite.out
      ? [
          ['↵', 'replace selection'],
          ['⌃↵', 'copy'],
          ['esc', 'back']
        ]
      : [
          ['↵', 'run'],
          ['↑↓', 'choose'],
          ['key', 'instant action'],
          ['esc', 'close']
        ]
    return (
      <div className="palette rewrite-mode" data-theme={theme}>
        <div className="rewrite-header">
          <SparkIcon className="action-spark" size={14} />
          <span className="rewrite-title">Rewrite selection</span>
          {rewrite.itemId == null && <span className="rewrite-staging">staging…</span>}
          <kbd>esc</kbd>
        </div>
        <div className="rewrite-source">
          <pre className="preview-text dimmed">{rewrite.text}</pre>
        </div>
        {rewrite.out ? (
          <div className="rewrite-result">
            <div className="result-header">
              <SparkIcon className="result-spark" size={13} />
              <span className="result-label" title={rewrite.out.label}>
                {rewrite.out.label}
              </span>
              <span className="result-badge">rewritten</span>
            </div>
            <pre className="preview-text result-output">{rewrite.out.output}</pre>
            <div className="result-actions">
              <button className="btn primary" onClick={() => void applyRewrite()}>
                Replace <kbd>↵</kbd>
              </button>
              <button className="btn" onClick={() => void copyRewrite()}>
                Copy <kbd>⌃↵</kbd>
              </button>
              <button className="btn" onClick={backRewrite}>
                Back <kbd>esc</kbd>
              </button>
            </div>
            <div className="replace-hint">↵ replaces your selection</div>
          </div>
        ) : (
          <>
            <ActionBar
              input={actionInput}
              onInput={(v) => {
                setActionInput(v)
                setActionHighlight(0)
              }}
              actions={filteredActions}
              highlight={actionHighlight}
              onHighlight={setActionHighlight}
              onRunAction={(a) => void runRewrite({ actionId: a.id }, a.title)}
              running={running}
              inputRef={actionInputRef}
            />
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

  return (
    <div className="palette" data-theme={theme}>
      <SearchBar
        value={query}
        onChange={setQuery}
        inputRef={searchInputRef}
        placeholder={
          mode.name === 'ask'
            ? micState === 'recording'
              ? 'Listening… release to review, then ↵ to send'
              : `Reply to @${mode.agentName ?? 'assistant'}… (↵ sends · empty ↵ pastes the answer)`
            : micState === 'recording'
              ? 'Listening… release to review, then ↵ to ask'
              : attachment
                ? `Ask ${targetAgent?.name ?? 'agent'} about the attached clip…`
                : undefined
        }
        actions={
          <>
            <button
              className={'icon-btn palette-mic ' + micState}
              title={
                micState === 'recording'
                  ? 'Stop and ask (⌘D)'
                  : micState === 'transcribing'
                    ? 'Transcribing…'
                    : 'Voice ask (⌘D)'
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
            <button
              className="icon-btn"
              title={`Open scratchpad (${MOD}E)`}
              onClick={openScratchpad}
              tabIndex={-1}
            >
              <PencilIcon size={15} />
            </button>
            <button className="icon-btn" title="Settings" onClick={openSettings} tabIndex={-1}>
              <GearIcon size={15} />
            </button>
          </>
        }
      />
      {mode.name === 'normal' && mentionTyping && (
        <div className="mention-pop">
          {mentionTyping.candidates.map((d, i) => (
            <button
              key={d.name}
              className={'mention-row' + (i === mentionHighlight ? ' selected' : '')}
              onMouseEnter={() => setMentionHighlight(i)}
              onClick={() => completeMention(d)}
            >
              <span className="mention-name">@{d.name}</span>
              {d.description && <span className="mention-desc">{d.description}</span>}
              <kbd>Tab</kbd>
            </button>
          ))}
        </div>
      )}
      {mode.name === 'ask' ? (
        <div className="ask-view">
          <div className="ask-view-head">
            <SparkIcon size={12} />
            <span className="ask-view-agent">@{mode.agentName ?? 'assistant'}</span>
            <span className="ask-view-sub">
              {askWaiting ? 'thinking…' : 'conversation'}
              {!mode.showHistory && ' · ↑ shows earlier messages'}
            </span>
          </div>
          <div className="ask-thread">
            {askThread.map((m) => {
              // Attached-clip context is for the model; the thread shows the
              // question plus a chip, not 6KB of page text.
              const cut = m.body.indexOf('<attached-clip>')
              const shown = cut < 0 ? m.body : m.body.slice(0, cut).trim()
              const chip =
                cut < 0
                  ? null
                  : m.body
                      .slice(cut + '<attached-clip>'.length)
                      .replace('</attached-clip>', '')
                      .trim()
                      .split('\n')[0]
                      .slice(0, 60)
              return (
                <div key={m.id} className={`agents-msg agents-${m.direction} agents-kind-${m.kind}`}>
                  <div className="agents-msg-head">
                    <span className="agents-msg-kind">
                      {m.direction === 'inbound' ? 'you' : `@${mode.agentName ?? 'assistant'}`}
                    </span>
                    <span>{relTime(m.createdAt)}</span>
                  </div>
                  <div className="agents-msg-body">
                    {m.direction === 'outbound' ? <Markdown text={shown} /> : shown}
                  </div>
                  {chip && <div className="ask-msg-attachment">📎 {chip}</div>}
                </div>
              )
            })}
            {askWaiting && (
              <div className="ask-waiting">
                <span className="ask-pulse" />
                thinking…
              </div>
            )}
            {askThread.length === 0 && <div className="ask-waiting">connecting…</div>}
            <div ref={askBottomRef} />
          </div>
          <div className="ask-actions">
            {latestAnswer && (
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
      <FilterChips
        chips={chips}
        activeId={activeChip.id}
        onSelect={(id) => {
          if (mode.name !== 'normal') setMode({ name: 'normal' })
          setActiveChipId(id)
        }}
      />
      {sessionChips.length > 0 && (
        <div className="sessions-row">
          <span className="sessions-label">Sessions</span>
          <div className="sessions-scroll">
            {sessionChips.map((c) => (
              <button
                key={c.id}
                className={'chip session-chip' + (c.id === activeChipId ? ' active' : '')}
                onClick={() => {
                  if (mode.name !== 'normal') setMode({ name: 'normal' })
                  // Toggle off back to All when the active session is clicked again.
                  setActiveChipId(c.id === activeChipId ? 'all' : c.id)
                }}
                tabIndex={-1}
              >
                {c.label}
                {c.count != null && c.count > 0 && <span className="chip-count">{c.count}</span>}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="main-area">
        <div className="list-pane">
          <button
            className={'ask-row' + (sel < 0 && mode.name === 'normal' ? ' selected' : '')}
            onClick={() => {
              if (askText) void askAssistant()
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
                Ask {targetAgent?.name ?? 'assistant'}: <em>“{askText}”</em>
              </span>
            ) : (
              <span className="ask-text dim">
                {attachment
                  ? 'Ask about this clip — type or dictate, then ↵'
                  : `Ask ${targetAgent?.name ?? 'your assistant'} — type, then ↵`}
              </span>
            )}
            {persistentAgents.length > 1 && (
              <span className="ask-agent" title={targetAgent?.description ?? ''}>
                @{targetAgent?.name}
                <kbd>⇧Tab</kbd>
              </span>
            )}
            <kbd>↵</kbd>
          </button>
          <ItemList
            items={visible}
            pinnedCount={pinnedCount}
            selected={sel}
            onSelect={(i) => {
              if (mode.name !== 'normal') setMode({ name: 'normal' })
              setSel(i)
            }}
            onPaste={(item) => void pasteItem(item, false)}
          />
        </div>
        <div className="right-pane">
          {mode.name === 'agent' && (
            <AgentPicker
              input={agentInput}
              onInput={(v) => {
                setAgentInput(v)
                setAgentHighlight(0)
              }}
              targets={filteredTargets}
              highlight={agentHighlight}
              onHighlight={setAgentHighlight}
              onPick={(t) => void pickAgentTarget(mode.item, t)}
              sending={running}
              inputRef={agentInputRef}
            />
          )}
          {mode.name === 'action' && (
            <ActionBar
              input={actionInput}
              onInput={(v) => {
                setActionInput(v)
                setActionHighlight(0)
              }}
              actions={mode.imageEdit ? [] : filteredActions}
              highlight={actionHighlight}
              onHighlight={setActionHighlight}
              onRunAction={(a) => runSavedAction(mode.item, a)}
              running={running}
              inputRef={actionInputRef}
              placeholder={
                mode.imageEdit
                  ? 'Describe the edit… ("remove the background", "circle the error in red")'
                  : undefined
              }
            />
          )}
          <PreviewPane item={previewItem} result={resultView} />
          {mode.name === 'result' && (
            <div className="result-actions pane-actions">
              <button className="btn primary" onClick={() => void pasteResult(mode, false)}>
                Paste <kbd>↵</kbd>
              </button>
              <button className="btn" onClick={() => void copyResult(mode)}>
                Copy <kbd>⌃↵</kbd>
              </button>
              <button className="btn" onClick={() => setMode({ name: 'action', item: mode.item })}>
                Back <kbd>esc</kbd>
              </button>
            </div>
          )}
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
