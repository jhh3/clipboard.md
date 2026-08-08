/**
 * Pure mechanics of the assistant's memory file: numbered-line ops and their
 * validation. Kept free of electron/db imports so it is directly testable —
 * this is the part of consolidation where a model mistake could destroy the
 * file, so it is the part that gets unit tests.
 *
 * Op semantics follow mem0's ADD/UPDATE/DELETE reconciliation, addressed by
 * line number (their integer-ID trick against hallucinated targets); a bad op
 * corrupts one line or is rejected outright, never the whole file.
 */

export const MEMORY_CAP = 16_384
export const MAX_DELETES_PER_PASS = 15

/** Section order matters: Recent stays LAST so the bridge can blind-append. */
export const SECTION_NAMES = [
  'About the user',
  'Preferences',
  'Current projects',
  'Assistant lessons',
  'Recent (unconsolidated)'
] as const
export const RECENT = 'Recent (unconsolidated)'

export interface MemoryOp {
  op: 'add' | 'update' | 'delete'
  /** 1-based line number in the numbered file; required for update/delete. */
  line?: number
  /** Target section for add; defaults to Recent when unknown. */
  section?: string
  text?: string
}

/** Entry count of the Recent tail — one of the adaptive consolidation triggers. */
export function recentEntryCount(text: string): number {
  const idx = text.indexOf(`## ${RECENT}`)
  if (idx < 0) return 0
  return text
    .slice(idx)
    .split('\n')
    .filter((l) => l.startsWith('- ')).length
}

/**
 * Apply ops mechanically. Updates/deletes address original line numbers (applied
 * bottom-up so numbering never shifts under them); adds insert at the end of
 * their section. Throws when an op is out of range or malformed — the caller
 * treats that as "keep the old file".
 */
export function applyOps(current: string, ops: MemoryOp[]): string {
  const lines = current.split('\n')
  const isHeader = (i: number): boolean => lines[i]?.startsWith('## ')

  const mutations = ops
    .filter((o) => o.op !== 'add')
    .sort((a, b) => (b.line ?? 0) - (a.line ?? 0))
  // Duplicate targets are rejected outright: after the first splice, a second op
  // on the same number would silently hit whatever line slid into its place.
  const targeted = new Set<number>()
  for (const op of mutations) {
    if (targeted.has(op.line ?? 0)) throw new Error(`two ops target line ${op.line}`)
    targeted.add(op.line ?? 0)
  }
  for (const op of mutations) {
    const idx = (op.line ?? 0) - 1
    if (idx < 0 || idx >= lines.length) throw new Error(`op line ${op.line} out of range`)
    if (isHeader(idx)) throw new Error(`op targets a section header (line ${op.line})`)
    if (op.op === 'update') {
      if (!op.text?.trim()) throw new Error('update without text')
      lines[idx] = op.text.startsWith('- ') ? op.text : `- ${op.text}`
    } else {
      lines.splice(idx, 1)
    }
  }

  for (const op of ops.filter((o) => o.op === 'add')) {
    if (!op.text?.trim()) throw new Error('add without text')
    const text = op.text.startsWith('- ') ? op.text : `- ${op.text}`
    const wanted = `## ${op.section ?? RECENT}`
    let headerIdx = lines.findIndex((l) => l.trim().toLowerCase() === wanted.trim().toLowerCase())
    if (headerIdx < 0) headerIdx = lines.findIndex((l) => l.trim() === `## ${RECENT}`)
    if (headerIdx < 0) {
      lines.push(`## ${RECENT}`, text)
      continue
    }
    // End of the section = the line before the next header (or EOF).
    let end = headerIdx + 1
    while (end < lines.length && !lines[end].startsWith('## ')) end++
    // Back over trailing blanks so entries stay contiguous.
    let insert = end
    while (insert > headerIdx + 1 && lines[insert - 1].trim() === '') insert--
    lines.splice(insert, 0, text)
  }

  return lines.join('\n')
}

/** Mechanical safety: a consolidation may only change what its ops declare. */
export function validateMemory(next: string, prev: string, ops: MemoryOp[]): string | null {
  if (!next.trim()) return 'result was empty'
  // An already-oversized file (bridge appends up to 24KB) must still be allowed
  // to SHRINK toward the cap — only growth beyond it is rejected.
  if (next.length > Math.max(MEMORY_CAP, prev.length)) return 'result exceeded the size cap'
  for (const s of SECTION_NAMES) {
    if (!next.includes(`## ${s}`)) return `section "${s}" went missing`
  }
  const deletes = ops.filter((o) => o.op === 'delete').length
  if (deletes > MAX_DELETES_PER_PASS)
    return `${deletes} deletes in one pass (max ${MAX_DELETES_PER_PASS})`
  const prevLines = prev.split('\n').length
  const nextLines = next.split('\n').length
  if (nextLines < prevLines - deletes - 1) return 'shrank more than its deletes account for'
  return null
}
