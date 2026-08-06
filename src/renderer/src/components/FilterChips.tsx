import type { ClipKind } from '@shared/types'

export interface Chip {
  id: string
  label: string
  /** Kind filter this chip applies (kind chips only). */
  kind?: ClipKind
  /** Smart collection id or 'pinned' (collection chips only). */
  collection?: string
  count?: number
}

interface Props {
  chips: Chip[]
  activeId: string
  onSelect: (id: string) => void
}

export default function FilterChips({ chips, activeId, onSelect }: Props) {
  return (
    <div className="chips-row" role="tablist">
      {chips.map((chip) => (
        <button
          key={chip.id}
          role="tab"
          aria-selected={chip.id === activeId}
          className={
            'chip' +
            (chip.id === activeId ? ' active' : '') +
            (chip.collection && chip.collection !== 'pinned' ? ' chip-smart' : '')
          }
          onClick={() => onSelect(chip.id)}
          tabIndex={-1}
        >
          {chip.label}
          {chip.count != null && chip.count > 0 && <span className="chip-count">{chip.count}</span>}
        </button>
      ))}
    </div>
  )
}
