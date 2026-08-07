import type { ReactNode } from 'react'
import { invoke } from '../lib/ipc'

/**
 * Slim header for the aux windows (#settings / #scratchpad).
 *
 * These windows use native WM decorations, so this is plain chrome — a label plus
 * a slot for window-level controls. (An earlier version implemented manual
 * dragging here to dodge a freeze; the freeze was actually blocking clipboard
 * reads on the UI thread, fixed in capture/clipboardIO.)
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
