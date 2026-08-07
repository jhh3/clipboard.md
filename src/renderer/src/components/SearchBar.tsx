import type { ReactNode, RefObject } from 'react'
import { SearchIcon } from './icons'

interface Props {
  value: string
  onChange: (v: string) => void
  inputRef: RefObject<HTMLInputElement | null>
  /** Icon buttons rendered at the right edge (screenshot / scratchpad / settings). */
  actions?: ReactNode
}

export default function SearchBar({ value, onChange, inputRef, actions }: Props) {
  return (
    <div className="search-bar">
      <SearchIcon className="search-icon" size={15} />
      <input
        ref={inputRef}
        className="search-input"
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search your clipboard…"
        spellCheck={false}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        autoFocus
      />
      {actions != null && <div className="search-actions">{actions}</div>}
      <kbd className="search-esc">esc</kbd>
    </div>
  )
}
