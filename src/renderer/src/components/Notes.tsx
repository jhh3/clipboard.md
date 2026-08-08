import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke, on } from '../lib/ipc'
import { useTheme } from '../hooks/useTheme'
import { useToasts } from '../hooks/useToasts'
import Toasts from './Toasts'
import NoteEditor from './NoteEditor'
import { relTime } from '../lib/time'
import type { Note, NoteSummary } from '@shared/types'

/**
 * The notes surface: list on the left, editor in the middle, backlinks underneath.
 *
 * Deliberately no folder tree. Titles, tags and search do the organising — the same
 * bet Obsidian and SilverBullet make, and it fits an app whose enrichment already
 * auto-titles and auto-tags. Manual filing is the thing this product's anti-goals
 * explicitly reject.
 */
export default function Notes(): React.JSX.Element {
  useTheme()
  const { toasts, addToast } = useToasts()

  const [notes, setNotes] = useState<NoteSummary[]>([])
  const [query, setQuery] = useState('')
  const [current, setCurrent] = useState<Note | null>(null)
  const [body, setBody] = useState('')
  const [title, setTitle] = useState('')
  const [links, setLinks] = useState<NoteSummary[]>([])
  const [outgoing, setOutgoing] = useState<Array<{ title: string; toId: number | null }>>([])
  const [saving, setSaving] = useState(false)

  const refreshList = useCallback(
    async (q = query) => {
      try {
        setNotes(await invoke('notes:list', { q }))
      } catch {
        /* the window may be closing */
      }
    },
    [query]
  )

  const loadLinks = useCallback(async (id: number) => {
    const [back, out] = await Promise.all([
      invoke('notes:backlinks', id),
      invoke('notes:outgoing', id)
    ])
    setLinks(back)
    setOutgoing(out)
  }, [])

  const openNote = useCallback(
    async (id: number) => {
      const note = await invoke('notes:get', id)
      if (!note) return
      setCurrent(note)
      setBody(note.content)
      setTitle(note.title)
      void loadLinks(id)
    },
    [loadLinks]
  )

  // ── autosave ───────────────────────────────────────────────────────────────
  // Notes save themselves. An explicit save button on a notes app is a way to lose
  // work; the debounce keeps it off the main thread on every keystroke.
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pending = useRef<{ title: string; content: string } | null>(null)

  const flush = useCallback(async () => {
    const id = current?.id
    const patch = pending.current
    if (!id || !patch) return
    pending.current = null
    setSaving(true)
    try {
      await invoke('notes:update', id, patch)
      void refreshList()
      void loadLinks(id)
    } finally {
      setSaving(false)
    }
  }, [current?.id, refreshList, loadLinks])

  const queueSave = useCallback(
    (next: { title?: string; content?: string }) => {
      if (!current) return
      pending.current = {
        title: next.title ?? title,
        content: next.content ?? body
      }
      if (saveTimer.current) clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => void flush(), 600)
    },
    [current, title, body, flush]
  )

  // Never leave an unsaved edit behind when the window goes away.
  useEffect(() => {
    const onHide = (): void => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
      void flush()
    }
    window.addEventListener('beforeunload', onHide)
    document.addEventListener('visibilitychange', onHide)
    return () => {
      window.removeEventListener('beforeunload', onHide)
      document.removeEventListener('visibilitychange', onHide)
    }
  }, [flush])

  // ── actions ────────────────────────────────────────────────────────────────
  const newNote = useCallback(async () => {
    const id = await invoke('notes:create', {})
    await refreshList()
    await openNote(id)
  }, [refreshList, openNote])

  const openDaily = useCallback(async () => {
    const id = await invoke('notes:daily')
    await refreshList()
    await openNote(id)
  }, [refreshList, openNote])

  const followLink = useCallback(
    async (linkTitle: string) => {
      // Following a link to a note that doesn't exist creates it — wiki behaviour,
      // and the reason unresolved edges are stored at all.
      const id = await invoke('notes:open-by-title', linkTitle)
      await refreshList()
      await openNote(id)
    },
    [refreshList, openNote]
  )

  const remove = useCallback(async () => {
    if (!current) return
    await invoke('notes:delete', current.id)
    setCurrent(null)
    setBody('')
    setTitle('')
    setLinks([])
    setOutgoing([])
    await refreshList()
    addToast('Note deleted', 'info')
  }, [current, refreshList, addToast])

  // ── wiring ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    void refreshList()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query])

  useEffect(() => {
    // Another window (menu bar, daily-note hotkey) asking us to show a note.
    return on('notes:open', (payload) => {
      if (payload.id) void openNote(payload.id)
      else void refreshList()
    })
  }, [openNote, refreshList])

  useEffect(() => {
    // Open the most recent note on first load so the window is never a blank slate.
    void (async () => {
      const list = await invoke('notes:list', {})
      setNotes(list)
      if (list.length > 0) void openNote(list[0].id)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        void newNote()
      } else if (mod && e.key.toLowerCase() === 'd') {
        e.preventDefault()
        void openDaily()
      } else if (mod && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        document.querySelector<HTMLInputElement>('.notes-search input')?.focus()
      } else if (e.key === 'Escape') {
        void flush()
        void invoke('window:hide')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [newNote, openDaily, flush])

  return (
    <div className="appwin notes-win">
      <aside className="notes-sidebar">
        <div className="notes-toolbar">
          <button className="notes-new" onClick={() => void newNote()} title="New note (⌘N)">
            + New
          </button>
          <button className="notes-daily" onClick={() => void openDaily()} title="Today's note (⌘D)">
            Today
          </button>
        </div>
        <div className="notes-search">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter notes… (⌘F)"
            spellCheck={false}
          />
        </div>
        <ul className="notes-list">
          {notes.map((n) => (
            <li
              key={n.id}
              className={'notes-row' + (current?.id === n.id ? ' selected' : '')}
              onClick={() => void openNote(n.id)}
            >
              <div className="notes-row-title">{n.title || 'Untitled note'}</div>
              <div className="notes-row-meta">
                <span>{relTime(n.updatedAt)}</span>
                {n.tags.slice(0, 2).map((t) => (
                  <span key={t} className="notes-tag">
                    {t}
                  </span>
                ))}
              </div>
            </li>
          ))}
          {notes.length === 0 && (
            <li className="notes-empty">{query ? 'No matching notes' : 'No notes yet — ⌘N'}</li>
          )}
        </ul>
      </aside>

      <main className="notes-main">
        {current ? (
          <>
            <div className="notes-head">
              <input
                className="notes-title"
                value={title}
                placeholder="Untitled note"
                onChange={(e) => {
                  setTitle(e.target.value)
                  queueSave({ title: e.target.value })
                }}
              />
              <span className={'notes-saved' + (saving ? ' busy' : '')}>
                {saving ? 'Saving…' : 'Saved'}
              </span>
              <button className="notes-delete" onClick={() => void remove()} title="Delete note">
                Delete
              </button>
            </div>

            <NoteEditor
              docKey={current.id}
              value={body}
              onChange={(v) => {
                setBody(v)
                queueSave({ content: v })
              }}
              onOpenLink={(t) => void followLink(t)}
            />

            <div className="notes-links">
              {outgoing.length > 0 && (
                <div className="notes-linkgroup">
                  <h4>Links to</h4>
                  <div className="notes-chips">
                    {outgoing.map((l) => (
                      <button
                        key={l.title}
                        className={'notes-chip' + (l.toId ? '' : ' unresolved')}
                        onClick={() => void followLink(l.title)}
                        title={l.toId ? 'Open note' : 'Create this note'}
                      >
                        {l.title}
                        {!l.toId && <span className="notes-chip-new">new</span>}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <div className="notes-linkgroup">
                <h4>Linked from ({links.length})</h4>
                {links.length === 0 ? (
                  <p className="notes-hint">
                    Nothing links here yet. Write <code>[[{title || 'this note'}]]</code> in another
                    note.
                  </p>
                ) : (
                  <div className="notes-chips">
                    {links.map((l) => (
                      <button key={l.id} className="notes-chip" onClick={() => void openNote(l.id)}>
                        {l.title || 'Untitled note'}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </>
        ) : (
          <div className="notes-blank">
            <p>Select a note, or press ⌘N to start one.</p>
          </div>
        )}
      </main>
      <Toasts toasts={toasts} />
    </div>
  )
}
