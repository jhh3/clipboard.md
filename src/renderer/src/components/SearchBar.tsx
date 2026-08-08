import type { ReactNode, RefObject } from 'react'
import { SearchIcon } from './icons'

interface Props {
  value: string
  onChange: (v: string) => void
  inputRef: RefObject<HTMLInputElement | null>
  /** Icon buttons rendered at the right edge (screenshot / scratchpad / settings). */
  actions?: ReactNode
  /** Overridden in ask mode, where the same input is the follow-up box. */
  placeholder?: string
}

export default function SearchBar({ value, onChange, inputRef, actions, placeholder }: Props) {
  return (
    <div className="search-bar">
      <SearchIcon className="search-icon" size={15} />
      <input
        ref={inputRef}
        className="search-input"
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder ?? 'Ask your assistant, or search your clipboard…'}
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
