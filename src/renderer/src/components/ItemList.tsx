import { useEffect, useMemo, useRef, useState } from 'react'
import type { ClipItem } from '@shared/types'
import ItemRow from './ItemRow'

const ROW_H = 40
const HEADER_H = 26
const OVERSCAN_PX = 400

interface Props {
  /** Flat visible list: pinned items first, then the rest. */
  items: ClipItem[]
  pinnedCount: number
  selected: number
  onSelect: (index: number) => void
  onPaste: (item: ClipItem) => void
}

type Entry =
  | { type: 'header'; label: string; top: number }
  | { type: 'row'; item: ClipItem; index: number; top: number }

/**
 * Simple windowed list: fixed-height absolutely-positioned rows inside a
 * spacer div, rendering only the entries near the viewport. No external lib.
 */
export default function ItemList({ items, pinnedCount, selected, onSelect, onPaste }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewH, setViewH] = useState(420)

  const { entries, totalH } = useMemo(() => {
    const es: Entry[] = []
    let top = 0
    items.forEach((item, index) => {
      if (index === 0 && pinnedCount > 0) {
        es.push({ type: 'header', label: 'Pinned', top })
        top += HEADER_H
      }
      if (index === pinnedCount && pinnedCount > 0) {
        es.push({ type: 'header', label: 'History', top })
        top += HEADER_H
      }
      es.push({ type: 'row', item, index, top })
      top += ROW_H
    })
    return { entries: es, totalH: top }
  }, [items, pinnedCount])

  // Track viewport height.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const measure = () => setViewH(el.clientHeight)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Keep the selected row in view.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const entry = entries.find((en) => en.type === 'row' && en.index === selected)
    if (!entry) return
    const pad = 4
    if (entry.top < el.scrollTop + pad) {
      el.scrollTop = Math.max(0, entry.top - HEADER_H - pad)
    } else if (entry.top + ROW_H > el.scrollTop + el.clientHeight - pad) {
      el.scrollTop = entry.top + ROW_H - el.clientHeight + pad
    }
  }, [selected, entries])

  const visible = entries.filter((en) => {
    const h = en.type === 'header' ? HEADER_H : ROW_H
    return en.top + h >= scrollTop - OVERSCAN_PX && en.top <= scrollTop + viewH + OVERSCAN_PX
  })

  return (
    <div
      className="item-list"
      ref={containerRef}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
    >
      {items.length === 0 ? (
        <div className="empty-list">
          <span className="empty-glyph">⌘</span>
          <span>Nothing here yet</span>
          <span className="empty-sub">Copy something, it will show up instantly</span>
        </div>
      ) : (
        <div className="list-spacer" style={{ height: totalH }}>
          {visible.map((en) =>
            en.type === 'header' ? (
              <div key={`h:${en.label}`} className="list-header" style={{ top: en.top }}>
                {en.label}
              </div>
            ) : (
              <ItemRow
                key={en.item.id}
                item={en.item}
                index={en.index}
                selected={en.index === selected}
                style={{ top: en.top }}
                onClick={() => onSelect(en.index)}
                onDoubleClick={() => onPaste(en.item)}
              />
            )
          )}
        </div>
      )}
    </div>
  )
}
