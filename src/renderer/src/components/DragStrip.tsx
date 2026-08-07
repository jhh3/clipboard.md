import type { ReactNode } from 'react'
import { invoke } from '../lib/ipc'

/**
 * Slim draggable titlebar for the aux windows (#settings / #scratchpad).
 * Tiling / undecorating WMs strip the native frame, which would leave these
 * windows unmovable — the strip is a `-webkit-app-region: drag` fallback.
 * Interactive children passed via `tools` are rendered inside a no-drag zone.
 */
export default function DragStrip({ title, tools }: { title: ReactNode; tools?: ReactNode }) {
  return (
    <header className="drag-strip">
      <span className="drag-strip-title">{title}</span>
      <div className="drag-strip-tools">{tools}</div>
      <button
        className="drag-strip-close"
        title="Close window"
        aria-label="Close window"
        onClick={() => void invoke('window:hide')}
      >
        ✕
      </button>
    </header>
  )
}
