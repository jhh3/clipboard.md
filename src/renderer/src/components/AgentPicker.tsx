import type { RefObject } from 'react'
import type { AgentProfile, AgentSession } from '@shared/types'
import { relTime } from '../lib/time'
import { SparkIcon, PlusIcon } from './icons'

/**
 * Target list for "send this clip to an agent": running sessions first, then a
 * "new session" entry per profile. Built in the palette, rendered here.
 */
export type AgentTarget =
  | { type: 'session'; session: AgentSession }
  | { type: 'new'; profile: AgentProfile }

export function targetLabel(t: AgentTarget): string {
  return t.type === 'session'
    ? (t.session.title ?? t.session.profile)
    : `new ${t.profile.name} session`
}

function shortCwd(cwd: string): string {
  return cwd.replace(/^\/(Users|home)\/[^/]+/, '~')
}

interface Props {
  input: string
  onInput: (v: string) => void
  targets: AgentTarget[]
  highlight: number
  onHighlight: (i: number) => void
  onPick: (t: AgentTarget) => void
  sending: boolean
  inputRef: RefObject<HTMLInputElement | null>
}

export default function AgentPicker({
  input,
  onInput,
  targets,
  highlight,
  onHighlight,
  onPick,
  sending,
  inputRef
}: Props): React.JSX.Element {
  return (
    <div className="agent-picker">
      <div className="agent-picker-head">
        <SparkIcon className="action-spark" size={14} />
        <span>Send to agent</span>
        {sending && <span className="agent-picker-busy">sending…</span>}
      </div>
      <input
        ref={inputRef}
        className="agent-picker-input"
        value={input}
        placeholder="Filter sessions…"
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => onInput(e.target.value)}
      />
      <ul className="agent-picker-list">
        {targets.map((t, i) => (
          <li
            key={t.type === 'session' ? t.session.key : `new:${t.profile.name}`}
            className={
              'agent-target' + (i === highlight ? ' selected' : '') + (t.type === 'new' ? ' new' : '')
            }
            onMouseEnter={() => onHighlight(i)}
            onClick={() => onPick(t)}
          >
            {t.type === 'session' ? (
              <>
                <span
                  className={
                    'agents-dot ' + t.session.status + (t.session.reachable ? ' reachable' : '')
                  }
                />
                <span className="agent-target-title">{targetLabel(t)}</span>
                <span className="agent-target-meta">
                  {shortCwd(t.session.cwd)} · {relTime(t.session.lastSeenAt)}
                  {t.session.status === 'dormant' && ' · asleep'}
                </span>
              </>
            ) : (
              <>
                <PlusIcon size={12} className="agent-target-plus" />
                <span className="agent-target-title">New {t.profile.name} session</span>
                <span className="agent-target-meta">{shortCwd(t.profile.cwd) || '~'}</span>
              </>
            )}
          </li>
        ))}
        {targets.length === 0 && <li className="agent-target-empty">No matching sessions</li>}
      </ul>
      <p className="agent-picker-hint">
        The clip becomes the session’s next message. Replies land in the inbox.
      </p>
    </div>
  )
}
