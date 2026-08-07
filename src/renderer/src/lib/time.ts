/** Compact relative time for dense list rows: "now", "45s", "12m", "3h", "5d", then a date. */
export function relTime(ts: number, now: number = Date.now()): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000))
  if (s < 10) return 'now'
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d`
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** Chip label for a work session: "Tue 14:02 — stripe debugging" (or just the stamp when untitled). */
export function sessionLabel(s: { title: string | null; startedAt: number }): string {
  const d = new Date(s.startedAt)
  const stamp =
    d.toLocaleDateString(undefined, { weekday: 'short' }) +
    ' ' +
    d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })
  return s.title ? `${stamp} — ${s.title}` : stamp
}

/** Full human timestamp for the preview metadata footer. */
export function fullDate(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}
