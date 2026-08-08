import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
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
import { sessionLabel } from '../lib/time'
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
import Toasts from './Toasts'
import { CameraIcon, GearIcon, PencilIcon, SparkIcon } from './icons'

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
  | { name: 'action'; item: ClipItem }
  | { name: 'agent'; item: ClipItem }
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
  const previewItem = mode.name === 'normal' ? selectedItem : mode.item

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
    if (mode.name === 'normal') {
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
  const askAssistant = useCallback(async () => {
    const text = query.trim()
    if (!text || runningRef.current) return
    runningRef.current = true
    setRunning(true)
    try {
      await invoke('agents:ask', text)
      setQuery('')
      addToast('Asked your assistant — the reply lands in the inbox', 'success')
      hideSoon()
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Could not reach the assistant', 'error')
    } finally {
      runningRef.current = false
      setRunning(false)
    }
  }, [query, addToast, hideSoon])

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
  const PSEUDO_ACTIONS: SavedAction[] = useMemo(
    () => [
      { id: 'x-send-agent', title: 'Send to agent…', key: 'a', type: 'builtin', appliesTo: ['text', 'image'] },
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
      const list = await invoke('actions:list', item.kind === 'image' ? 'image' : 'text')
      setActions([...list, ...PSEUDO_ACTIONS])
    } catch {
      setActions(PSEUDO_ACTIONS)
    }
    setActionInput('')
    // Empty input → the first action is preselected.
    setActionHighlight(0)
    setMode({ name: 'action', item })
  }, [actionTarget, sel, PSEUDO_ACTIONS])

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
    [runTransform, enterAgentMode, noteFromClip]
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
    const item = selectedItem
    // Only hand over textual clips: images/files/secrets open a blank pad.
    const textual = item && !item.secret && item.kind !== 'image' && item.kind !== 'files'
    void invoke('window:open-scratchpad', textual ? item.id : undefined).catch(() => {})
  }, [selectedItem])

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
      if (e.key === 'Enter') {
        e.preventDefault()
        runActionEnter(mode.item)
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActionHighlight((h) => Math.min(h + 1, Math.max(0, filteredActions.length - 1)))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActionHighlight((h) => Math.max(h - 1, 0))
      } else if (!actionInput && !mod && !e.altKey && e.key.length === 1) {
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
    // Tab and ⌘K both open the action panel (⌘K for the Raycast/Linear reflex).
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
      // Above the first item sits the ask row.
      setSel((s) => Math.max(s - 1, -1))
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      if (sel < 0) {
        // The ask row: Enter hands the typed text to the personal assistant.
        // With nothing typed there is nothing to ask — fall back to pasting the
        // most recent clip, which is what a bare "summon, Enter" always did.
        if (query.trim()) void askAssistant()
        else if (visible[0]) void pasteItem(visible[0], e.shiftKey)
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
    if (mod && e.key.toLowerCase() === 'p') {
      e.preventDefault()
      if (selectedItem) void togglePin(selectedItem)
      return
    }
    if (mod && e.key === 'Backspace') {
      e.preventDefault()
      if (selectedItem) void deleteItem(selectedItem)
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
            ['↵', query.trim() ? 'ask assistant' : 'paste latest'],
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
      : mode.name === 'action'
        ? [
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
        actions={
          <>
            <button
              className="icon-btn"
              title="Capture screenshot · takes GNOME's picker (Ctrl+Shift+S)"
              onClick={() => void captureScreenshot()}
              tabIndex={-1}
            >
              <CameraIcon size={15} />
            </button>
            <button
              className="icon-btn"
              title="Open scratchpad (Ctrl+E)"
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
              if (query.trim()) void askAssistant()
              else searchInputRef.current?.focus()
            }}
            tabIndex={-1}
          >
            <SparkIcon className="ask-spark" size={14} />
            {query.trim() ? (
              <span className="ask-text">
                Ask assistant: <em>“{query.trim()}”</em>
              </span>
            ) : (
              <span className="ask-text dim">Ask your assistant — type, then ↵</span>
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
              actions={filteredActions}
              highlight={actionHighlight}
              onHighlight={setActionHighlight}
              onRunAction={(a) => runSavedAction(mode.item, a)}
              running={running}
              inputRef={actionInputRef}
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
