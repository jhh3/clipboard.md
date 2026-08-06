import type { RefObject } from 'react'
import { SearchIcon } from './icons'

interface Props {
  value: string
  onChange: (v: string) => void
  inputRef: RefObject<HTMLInputElement | null>
}

export default function SearchBar({ value, onChange, inputRef }: Props) {
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
      <kbd className="search-esc">esc</kbd>
    </div>
  )
}
