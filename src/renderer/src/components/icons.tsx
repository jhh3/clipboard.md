import type { ReactNode } from 'react'
import type { ClipKind } from '@shared/types'

interface SvgProps {
  children: ReactNode
  className?: string
  size?: number
}

function Svg({ children, className, size = 14 }: SvgProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

export function KindIcon({
  kind,
  secret,
  className,
  size
}: {
  kind: ClipKind
  secret?: boolean
  className?: string
  size?: number
}) {
  if (secret) {
    return (
      <Svg className={className} size={size}>
        <rect x="3" y="7" width="10" height="7" rx="1.5" />
        <path d="M5 7V5a3 3 0 0 1 6 0v2" />
      </Svg>
    )
  }
  switch (kind) {
    case 'image':
      return (
        <Svg className={className} size={size}>
          <rect x="2" y="3" width="12" height="10" rx="1.5" />
          <circle cx="5.5" cy="6.5" r="1" />
          <path d="M2.5 11l3-3 3.5 3.5 2.5-2.5 2 2" />
        </Svg>
      )
    case 'link':
      return (
        <Svg className={className} size={size}>
          <path d="M6.5 9.5l3-3" />
          <path d="M7.5 4.8l1.2-1.2a2.4 2.4 0 0 1 3.4 3.4L10.9 8.2" />
          <path d="M8.5 11.2l-1.2 1.2a2.4 2.4 0 0 1-3.4-3.4L5.1 7.8" />
        </Svg>
      )
    case 'code':
      return (
        <Svg className={className} size={size}>
          <path d="M6 5L3 8l3 3" />
          <path d="M10 5l3 3-3 3" />
        </Svg>
      )
    case 'color':
      return (
        <Svg className={className} size={size}>
          <path d="M8 2.5S4.2 7 4.2 9.8a3.8 3.8 0 0 0 7.6 0C11.8 7 8 2.5 8 2.5z" />
        </Svg>
      )
    case 'files':
      return (
        <Svg className={className} size={size}>
          <path d="M4 2h5l3 3v9H4z" />
          <path d="M9 2v3h3" />
        </Svg>
      )
    case 'html':
      return (
        <Svg className={className} size={size}>
          <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" opacity="0.55" />
          <path d="M6.2 6.5L4.7 8l1.5 1.5" />
          <path d="M9.8 6.5L11.3 8l-1.5 1.5" />
        </Svg>
      )
    default:
      return (
        <Svg className={className} size={size}>
          <path d="M3 4.5h10" />
          <path d="M3 8h10" />
          <path d="M3 11.5h6" />
        </Svg>
      )
  }
}

export function PinIcon({ className, size }: { className?: string; size?: number }) {
  return (
    <Svg className={className} size={size}>
      <path
        d="M6 1.8h4v1.3L9 4.2v2.9l2.2 1.5v1.2H4.8V8.6L7 7.1V4.2L6 3.1z"
        fill="currentColor"
        stroke="none"
      />
      <path d="M8 9.8V14" />
    </Svg>
  )
}

export function SearchIcon({ className, size }: { className?: string; size?: number }) {
  return (
    <Svg className={className} size={size}>
      <circle cx="7" cy="7" r="4" />
      <path d="M10.2 10.2L13.5 13.5" />
    </Svg>
  )
}

export function SparkIcon({ className, size }: { className?: string; size?: number }) {
  return (
    <Svg className={className} size={size}>
      <path
        d="M8 1.6l1.3 4L13.4 7l-4.1 1.3L8 12.4 6.7 8.3 2.6 7l4.1-1.4z"
        fill="currentColor"
        stroke="none"
      />
      <circle cx="12.8" cy="12.4" r="1.1" fill="currentColor" stroke="none" />
    </Svg>
  )
}
