import type { CSSProperties } from 'react'
import type { ClipItem } from '@shared/types'
import { relTime } from '../lib/time'
import { KindIcon, PinIcon } from './icons'

interface Props {
  item: ClipItem
  /** Index in the flat visible list (drives Ctrl+1..9 hints). */
  index: number
  selected: boolean
  style: CSSProperties
  onClick: () => void
  onDoubleClick: () => void
}

export function rowTitle(item: ClipItem): string {
  if (item.secret) return '••••• (concealed)'
  if (item.autoTitle) return item.autoTitle
  if (item.kind === 'image') {
    return item.width && item.height ? `Image ${item.width}×${item.height}` : 'Image'
  }
  const text = item.preview.replace(/\s+/g, ' ').trim()
  return text || '(empty)'
}

export default function ItemRow({ item, index, selected, style, onClick, onDoubleClick }: Props) {
  return (
    <div
      className={'item-row' + (selected ? ' selected' : '') + (item.secret ? ' secret' : '')}
      style={style}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
    >
      <div className="row-icon">
        {item.kind === 'image' && item.thumb && !item.secret ? (
          <img className="row-thumb" src={item.thumb} alt="" draggable={false} />
        ) : item.kind === 'color' && !item.secret ? (
          <span className="row-swatch" style={{ background: item.content }} />
        ) : (
          <KindIcon kind={item.kind} secret={item.secret} />
        )}
      </div>
      <div className="row-main">
        <div className="row-title">{rowTitle(item)}</div>
        <div className="row-meta">
          {item.sourceApp && <span className="meta-app">{item.sourceApp}</span>}
          <span className="meta-time">{relTime(item.lastCopiedAt || item.createdAt)}</span>
          {item.tags.slice(0, 3).map((t) => (
            <span key={t} className="tag-chip">
              {t}
            </span>
          ))}
        </div>
      </div>
      {item.pinned && <PinIcon className="row-pin" size={12} />}
      {index < 9 && <kbd className="row-quick">{index + 1}</kbd>}
    </div>
  )
}
