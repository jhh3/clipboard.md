import { useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { invoke } from '../lib/ipc'

/**
 * Titlebar for the frameless aux windows (#settings / #scratchpad).
 *
 * Dragging is implemented manually (pointer capture -> main moves the window)
 * rather than with `-webkit-app-region: drag`. Both the native frame and the
 * app-region path route through the WM's interactive-move, which on mutter uses
 * the _NET_WM_SYNC_REQUEST handshake — when frames aren't acknowledged fast
 * enough the WM shows "Not Responding" roughly a second into a drag. Moving the
 * window ourselves sidesteps that protocol completely.
 */
export default function DragStrip({ title, tools }: { title: ReactNode; tools?: ReactNode }) {
  const drag = useRef<{ originX: number; originY: number; winX: number; winY: number } | null>(null)
  const frame = useRef<number | null>(null)
  const pending = useRef<{ x: number; y: number } | null>(null)

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>): void => {
    if (e.button !== 0) return
    const target = e.currentTarget
    void invoke('window:drag-begin').then((pos) => {
      drag.current = { originX: e.screenX, originY: e.screenY, winX: pos.x, winY: pos.y }
      target.setPointerCapture(e.pointerId)
    })
  }

  const flush = (): void => {
    frame.current = null
    const next = pending.current
    pending.current = null
    if (next) void invoke('window:drag-move', next)
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLElement>): void => {
    const d = drag.current
    if (!d) return
    // Coalesce to one move per frame: pointermove can fire far faster than the
    // compositor, and each one is an IPC round trip.
    pending.current = {
      x: d.winX + (e.screenX - d.originX),
      y: d.winY + (e.screenY - d.originY)
    }
    if (frame.current === null) frame.current = requestAnimationFrame(flush)
  }

  const endDrag = (e: ReactPointerEvent<HTMLElement>): void => {
    if (!drag.current) return
    drag.current = null
    if (frame.current !== null) {
      cancelAnimationFrame(frame.current)
      frame.current = null
      flush()
    }
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
  }

  return (
    <header
      className="drag-strip"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      <span className="drag-strip-title">{title}</span>
      <div className="drag-strip-tools" onPointerDown={(e) => e.stopPropagation()}>
        {tools}
      </div>
      <button
        className="drag-strip-close"
        title="Close window"
        aria-label="Close window"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => void invoke('window:hide')}
      >
        ✕
      </button>
    </header>
  )
}
