import type { RefObject } from 'react'
import type { SavedAction } from '@shared/types'
import { SparkIcon } from './icons'

interface Props {
  input: string
  onInput: (v: string) => void
  /** Actions already fuzzy-filtered by the current input. */
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
  const freeMode = input.trim().length > 0 && actions.length === 0
  return (
    <div className="action-bar">
      <div className="action-input-row">
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
        {running ? (
          <span className="spinner" aria-label="Running…" />
        ) : freeMode ? (
          <span className="free-hint">
            <kbd>↵</kbd> Run as AI prompt
          </span>
        ) : null}
      </div>
      {actions.length > 0 && (
        <div className="action-list">
          {actions.map((a, i) => (
            <button
              key={a.id}
              className={'action-item' + (i === highlight ? ' highlighted' : '')}
              onClick={() => onRunAction(a)}
              onMouseEnter={() => onHighlight(i)}
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
