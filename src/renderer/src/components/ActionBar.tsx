import type { RefObject } from 'react'
import type { SavedAction } from '@shared/types'
import { SparkIcon } from './icons'

interface Props {
  input: string
  onInput: (v: string) => void
  /**
   * Actions already fuzzy-filtered by the current input. With an empty input
   * this is the raw 'actions:list' order — deliberately NOT alphabetized: the
   * interesting AI actions come first by design.
   */
  actions: SavedAction[]
  highlight: number
  onHighlight: (i: number) => void
  onRunAction: (a: SavedAction) => void
  running: boolean
  inputRef: RefObject<HTMLInputElement | null>
}

export default function ActionBar({
  input,
  onInput,
  actions,
  highlight,
  onHighlight,
  onRunAction,
  running,
  inputRef
}: Props) {
  const typed = input.trim().length > 0
  const freeMode = typed && actions.length === 0
  const highlighted = actions[highlight] ?? actions[0] ?? null
  return (
    <div className="action-bar">
      <div className={'action-input-row' + (running ? ' running' : '')}>
        <SparkIcon className="action-spark" size={14} />
        <input
          ref={inputRef}
          className="action-input"
          type="text"
          value={input}
          onChange={(e) => onInput(e.target.value)}
          placeholder="Filter actions, or type an AI prompt…"
          spellCheck={false}
          autoComplete="off"
          autoFocus
        />
        {/* Dynamic Enter hint: make it obvious whether ↵ runs the highlighted
            match or fires the raw text as a free AI prompt. */}
        {running ? (
          <span className="spinner" aria-label="Running…" />
        ) : freeMode ? (
          <span className="free-hint">
            <kbd>↵</kbd> Run as AI prompt
          </span>
        ) : typed && highlighted ? (
          <span className="free-hint match">
            <kbd>↵</kbd> Run <span className="hint-title">“{highlighted.title}”</span>
          </span>
        ) : null}
      </div>
      {actions.length > 0 && (
        <div className="action-list">
          {actions.map((a, i) => (
            <button
              key={a.id}
              className={
                'action-item' +
                (i === highlight ? ' highlighted' : '') +
                (running && i === highlight ? ' running' : '')
              }
              // Keep focus in the action input: rows are mouse targets, not tab stops.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                if (!running) onRunAction(a)
              }}
              onMouseEnter={() => {
                if (!running) onHighlight(i)
              }}
              disabled={running}
              tabIndex={-1}
            >
              <span className="action-title">{a.title}</span>
              {a.type === 'prompt' && <span className="action-ai">AI</span>}
              {a.key && (
                <kbd className={'action-key' + (input ? ' inactive' : '')}>{a.key}</kbd>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
