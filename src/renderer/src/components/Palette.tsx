import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AppSettings,
  ClipItem,
  SavedAction,
  SmartCollection,
  PasteOutcome,
  TransformRequest
} from '@shared/types'
import { invoke, on } from '../lib/ipc'
import { fuzzyFilter } from '../lib/fuzzy'
import { useSearch } from '../hooks/useSearch'
import { useKeymap } from '../hooks/useKeymap'
import SearchBar from './SearchBar'
import FilterChips, { type Chip } from './FilterChips'
import ItemList from './ItemList'
import PreviewPane, { type TransformView } from './PreviewPane'
import ActionBar from './ActionBar'
import Toasts, { type Toast } from './Toasts'

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
  | { name: 'result'; item: ClipItem; req: TransformRequest; out: TransformOutput; label: string }

const HIDE_DELAY_MS = 900
const TOAST_MS = 2500

export default function Palette() {
  // ── core state ────────────────────────────────────────────────────────────
  const [query, setQuery] = useState('')
  const [activeChipId, setActiveChipId] = useState('all')
  const [collections, setCollections] = useState<SmartCollection[]>([])
  const [sel, setSel] = useState(0)
  const [mode, setMode] = useState<Mode>({ name: 'normal' })
  const [actions, setActions] = useState<SavedAction[]>([])
  const [actionInput, setActionInput] = useState('')
  const [actionHighlight, setActionHighlight] = useState(0)
  const [running, setRunning] = useState(false)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [theme, setTheme] = useState<'dark' | 'light'>('dark')
  const [shownTick, setShownTick] = useState(0)

  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const actionInputRef = useRef<HTMLInputElement | null>(null)
  const toastSeq = useRef(0)

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

  const selectedItem: ClipItem | null = visible[sel] ?? null
  const previewItem = mode.name === 'normal' ? selectedItem : mode.item

  // Reset selection when the query/filter changes; clamp when results shrink.
  useEffect(() => setSel(0), [query, activeChipId])
  useEffect(() => {
    setSel((s) => (visible.length === 0 ? 0 : Math.min(s, visible.length - 1)))
  }, [visible.length])

  // ── toasts ────────────────────────────────────────────────────────────────
  const addToast = useCallback((message: string, kind: Toast['kind'] = 'info') => {
    const id = ++toastSeq.current
    setToasts((ts) => [...ts, { id, message, kind }])
    window.setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), TOAST_MS)
  }, [])

  // ── collections + settings ────────────────────────────────────────────────
  const loadCollections = useCallback(() => {
    invoke('collections:list')
      .then(setCollections)
      .catch(() => {})
  }, [])

  useEffect(() => {
    loadCollections()
  }, [loadCollections])

  useEffect(() => {
    let settingsTheme: AppSettings['theme'] = 'system'
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () =>
      setTheme(settingsTheme === 'system' ? (mq.matches ? 'dark' : 'light') : settingsTheme)
    apply()
    invoke('settings:get')
      .then((s) => {
        settingsTheme = s.theme
        apply()
      })
      .catch(() => {})
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [])

  // ── main-process events ───────────────────────────────────────────────────
  useEffect(() => {
    const offItems = on('items:changed', () => {
      void refreshRef.current()
      loadCollections()
    })
    const offToast = on('toast', (t) => addToast(t.message, t.kind))
    const offShown = on('palette:shown', (p) => {
      setMode({ name: 'normal' })
      setQuery('')
      setSel(0)
      setActiveChipId(p.collection ? (p.collection === 'pinned' ? 'pinned' : `col:${p.collection}`) : 'all')
      setShownTick((t) => t + 1)
    })
    return () => {
      offItems()
      offToast()
      offShown()
    }
  }, [addToast, loadCollections])

  // ── focus management ──────────────────────────────────────────────────────
  useEffect(() => {
    if (mode.name === 'normal') {
      searchInputRef.current?.focus()
    } else if (mode.name === 'action') {
      actionInputRef.current?.focus()
    } else {
      ;(document.activeElement as HTMLElement | null)?.blur()
    }
  }, [mode.name, shownTick])

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

  // ── action mode ───────────────────────────────────────────────────────────
  const enterActionMode = useCallback(async () => {
    const item = visible[sel]
    if (!item) return
    try {
      const list = await invoke('actions:list', item.kind === 'image' ? 'image' : 'text')
      setActions(list)
    } catch {
      setActions([])
    }
    setActionInput('')
    setActionHighlight(0)
    setMode({ name: 'action', item })
  }, [visible, sel])

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
        setRunning(false)
      }
    },
    [addToast]
  )

  const runSavedAction = useCallback(
    (item: ClipItem, action: SavedAction) => {
      void runTransform(item, { itemId: item.id, actionId: action.id }, action.title)
    },
    [runTransform]
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
    async (m: Extract<Mode, { name: 'result' }>) => {
      // Commit is fire-and-forget: the derived clip lands in history either way.
      void invoke('transform:commit', {
        ...m.req,
        output: m.out.output,
        outputKind: m.out.outputKind
      }).catch(() => {})
      try {
        handleOutcome(await invoke('transform:paste-output', m.out))
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

    if (mode.name === 'result') {
      if (e.key === 'Escape') {
        e.preventDefault()
        setMode({ name: 'action', item: mode.item })
      } else if (e.key === 'Enter' && mod) {
        e.preventDefault()
        void copyResult(mode)
      } else if (e.key === 'Enter') {
        e.preventDefault()
        void pasteResult(mode)
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
    if (e.key === 'Tab') {
      e.preventDefault()
      void enterActionMode()
      return
    }
    if (e.key === 'ArrowDown' && !mod) {
      e.preventDefault()
      setSel((s) => Math.min(s + 1, Math.max(0, visible.length - 1)))
      return
    }
    if (e.key === 'ArrowUp' && !mod) {
      e.preventDefault()
      setSel((s) => Math.max(s - 1, 0))
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
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
      ? [
          ['↵', 'paste'],
          ['⇧↵', 'plain'],
          ['⌃↵', 'copy'],
          ['Tab', 'actions'],
          ['⌃1-9', 'quick'],
          ['⌃P', 'pin'],
          ['⌃⌫', 'delete']
        ]
      : mode.name === 'action'
        ? [
            ['↵', 'run'],
            ['↑↓', 'choose'],
            ['key', 'instant action'],
            ['esc', 'back']
          ]
        : [
            ['↵', 'paste result'],
            ['⌃↵', 'copy result'],
            ['esc', 'back']
          ]

  return (
    <div className="palette" data-theme={theme}>
      <SearchBar value={query} onChange={setQuery} inputRef={searchInputRef} />
      <FilterChips
        chips={chips}
        activeId={activeChip.id}
        onSelect={(id) => {
          if (mode.name !== 'normal') setMode({ name: 'normal' })
          setActiveChipId(id)
        }}
      />
      <div className="main-area">
        <div className="list-pane">
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
          {mode.name !== 'normal' && (
            <ActionBar
              input={actionInput}
              onInput={(v) => {
                setActionInput(v)
                setActionHighlight(0)
              }}
              actions={mode.name === 'action' ? filteredActions : []}
              highlight={actionHighlight}
              onHighlight={setActionHighlight}
              onRunAction={(a) => runSavedAction(mode.item, a)}
              running={running}
              inputRef={actionInputRef}
            />
          )}
          <PreviewPane item={previewItem} result={resultView} />
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
      <Toasts toasts={toasts} />
    </div>
  )
}
