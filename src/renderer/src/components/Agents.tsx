import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke, on } from '../lib/ipc'
import { useTheme } from '../hooks/useTheme'
import { useToasts } from '../hooks/useToasts'
import Toasts from './Toasts'
import Markdown from './Markdown'
import { relTime } from '../lib/time'
import type { AgentMessage, AgentProfile, AgentSession } from '@shared/types'

/**
 * Agent sessions and their inbox.
 *
 * Sessions here are only the ones clipboard.md launched, because those are the only
 * ones we can speak into — each was started with a bridge MCP attached. Listing
 * sessions we cannot address would be listing things that don't work.
 */
export default function Agents(): React.JSX.Element {
  useTheme()
  const { toasts, addToast } = useToasts()

  const [sessions, setSessions] = useState<AgentSession[]>([])
  const [profiles, setProfiles] = useState<AgentProfile[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [thread, setThread] = useState<AgentMessage[]>([])
  const [reply, setReply] = useState('')
  const [launching, setLaunching] = useState(false)
  const bottom = useRef<HTMLDivElement>(null)

  const refresh = useCallback(async () => {
    const list = await invoke('agents:sessions', false)
    setSessions(list)
    setSelected((cur) => cur ?? list[0]?.key ?? null)
  }, [])

  const loadThread = useCallback(async (key: string) => {
    setThread(await invoke('agents:messages', key))
    // Opening a session is reading it — the unread badge should clear here, not
    // require a separate gesture.
    await invoke('agents:mark-read', key)
    void refreshUnreadOnly()
  }, [])

  const refreshUnreadOnly = useCallback(async () => {
    setSessions(await invoke('agents:sessions', false))
  }, [])

  useEffect(() => {
    void refresh()
    void invoke('agents:profiles').then(setProfiles)
  }, [refresh])

  useEffect(() => {
    if (selected) void loadThread(selected)
  }, [selected, loadThread])

  // Agents talk while nobody is looking; the thread has to follow along.
  useEffect(() => {
    return on('agents:changed', () => {
      void refresh()
      if (selected) void invoke('agents:messages', selected).then(setThread)
    })
  }, [refresh, selected])

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' })
  }, [thread.length])

  // Poll while the window is open.
  //
  // `reachable` flips when the bridge publishes its discovery file a second or two
  // after launch, and the sweep changes status behind our back. Without this the
  // list keeps whatever snapshot it had at launch — which showed a perfectly
  // healthy session as "bridge starting…" forever, with the reply box disabled.
  useEffect(() => {
    const t = setInterval(() => {
      if (document.hidden) return
      void invoke('agents:sessions', false).then(setSessions).catch(() => {})
    }, 2000)
    return () => clearInterval(t)
  }, [])

  const launch = useCallback(
    async (profileName: string) => {
      setLaunching(true)
      try {
        const key = await invoke('agents:launch', { profile: profileName })
        await refresh()
        setSelected(key)
        addToast(`Started a ${profileName} session`, 'success')
      } catch (err) {
        addToast(err instanceof Error ? err.message : 'Could not start the session', 'error')
      } finally {
        setLaunching(false)
      }
    },
    [refresh, addToast]
  )

  const send = useCallback(async () => {
    const text = reply.trim()
    if (!text || !selected) return
    setReply('')
    const ok = await invoke('agents:send', selected, text, 'message')
    if (!ok) {
      addToast('Could not reach that session — it may have exited', 'error')
      setReply(text) // don't eat what they typed
      return
    }
    setThread(await invoke('agents:messages', selected))
  }, [reply, selected, addToast])

  const end = useCallback(
    async (key: string) => {
      await invoke('agents:end', key)
      await refresh()
      addToast('Session ended', 'info')
    },
    [refresh, addToast]
  )

  const current = sessions.find((s) => s.key === selected) ?? null

  return (
    <div className="appwin agents-win">
      <aside className="agents-sidebar">
        <div className="agents-launch">
          {profiles.map((p) => (
            <button key={p.name} disabled={launching} onClick={() => void launch(p.name)}>
              + {p.name}
            </button>
          ))}
        </div>
        <ul className="agents-list">
          {sessions.map((s) => (
            <li
              key={s.key}
              className={'agents-row' + (selected === s.key ? ' selected' : '')}
              onClick={() => setSelected(s.key)}
            >
              <div className="agents-row-top">
                <span className={'agents-dot ' + s.status + (s.reachable ? ' reachable' : '')} />
                <span className="agents-row-title">{s.title ?? s.profile}</span>
                {s.unread > 0 && <span className="agents-unread">{s.unread}</span>}
              </div>
              <div className="agents-row-meta">
                {s.cwd.replace(/^\/Users\/[^/]+/, '~')} · {relTime(s.lastSeenAt)}
              </div>
            </li>
          ))}
          {sessions.length === 0 && (
            <li className="agents-empty">No sessions. Start one above — only sessions started here can be messaged.</li>
          )}
        </ul>
      </aside>

      <main className="agents-main">
        {current ? (
          <>
            <header className="agents-head">
              <div>
                <strong>{current.title ?? current.profile}</strong>
                <span className="agents-head-meta">
                  {current.status}
                  {!current.reachable && current.status === 'running' && ' · bridge starting…'}
                  {current.status === 'dormant' && ' · sleeping, wakes on your next message'}
                </span>
              </div>
              <div className="agents-head-actions">
                <code className="agents-attach">tmux attach -t {current.key}</code>
                <button onClick={() => void end(current.key)}>End</button>
              </div>
            </header>

            <div className="agents-thread">
              {thread.length === 0 && (
                <p className="agents-hint">
                  Nothing yet. The agent reports here as it works — progress, questions, results.
                </p>
              )}
              {thread.map((m) => (
                <div
                  key={m.id}
                  className={`agents-msg agents-${m.direction} agents-kind-${m.kind}`}
                >
                  <div className="agents-msg-head">
                    <span className="agents-msg-kind">
                      {m.direction === 'inbound' ? 'you' : m.kind}
                    </span>
                    <span>{relTime(m.createdAt)}</span>
                  </div>
                  <div className="agents-msg-body">
                    {m.direction === 'outbound' ? <Markdown text={m.body} /> : m.body}
                  </div>
                </div>
              ))}
              <div ref={bottom} />
            </div>

            <div className="agents-reply">
              <textarea
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                onKeyDown={(e) => {
                  // Enter sends; Shift+Enter is a newline. Answering a blocked agent
                  // should be one keystroke.
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    void send()
                  }
                }}
                placeholder={
                  current.status === 'dormant'
                    ? 'Sleeping — sending will wake it and continue the conversation…'
                    : current.reachable
                      ? 'Reply to the agent… (Enter to send, Shift+Enter for a newline)'
                      : 'Waiting for the session’s bridge to come up…'
                }
                disabled={!current.reachable && current.status !== 'dormant'}
                rows={3}
              />
            </div>
          </>
        ) : (
          <div className="agents-blank">
            <p>Start a session to begin.</p>
          </div>
        )}
      </main>
      <Toasts toasts={toasts} />
    </div>
  )
}
