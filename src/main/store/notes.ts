import { getDb } from './db'
import { contentHash } from './items'
import type { Note, NoteSummary } from '@shared/types'

/**
 * Notes: items with kind='note', plus a title, mutability, and [[wikilinks]].
 *
 * Deliberately NOT a separate table — see the migration in db.ts. Everything that
 * makes clips searchable (FTS5, embeddings, tags, enrichment) already keys off
 * `items`, so notes get all of it by being items.
 *
 * The one thing notes must not inherit is clip dedupe: `upsertClip` collapses
 * identical content by hash, which for notes would mean two empty new notes becoming
 * the same note. Notes always insert.
 */

/** `[[Some Note]]` — the Obsidian/SilverBullet spelling. */
const WIKILINK_RE = /\[\[([^\]|]+?)(?:\|[^\]]*?)?\]\]/g

/**
 * Extract wikilink targets from note body text.
 *
 * Titles are trimmed and de-duplicated case-insensitively, because `[[Todo]]` and
 * `[[todo]]` are the same note to a human and storing both would double every
 * backlink. Exported for tests — link parsing is the part most likely to regress.
 */
export function parseWikilinks(body: string): string[] {
  const seen = new Map<string, string>()
  for (const match of body.matchAll(WIKILINK_RE)) {
    const title = match[1].trim()
    if (!title) continue
    const key = title.toLowerCase()
    if (!seen.has(key)) seen.set(key, title)
  }
  return [...seen.values()]
}

/** First non-empty line, trimmed of leading markdown heading marks. */
export function deriveTitle(body: string): string {
  for (const line of body.split('\n')) {
    const trimmed = line.replace(/^#+\s*/, '').trim()
    if (trimmed) return trimmed.slice(0, 120)
  }
  return 'Untitled note'
}

function rowToNote(r: Record<string, unknown>): Note {
  return {
    id: r.id as number,
    title: (r.title as string) ?? '',
    content: (r.content as string) ?? '',
    createdAt: r.created_at as number,
    updatedAt: (r.updated_at as number) ?? (r.created_at as number),
    pinned: !!r.pinned,
    tags: JSON.parse((r.tags as string) ?? '[]') as string[]
  }
}

export function createNote(input: { title?: string; content?: string } = {}): number {
  const db = getDb()
  const now = Date.now()
  const content = input.content ?? ''
  const title = (input.title ?? '').trim() || deriveTitle(content)
  // The hash still has to be unique (there's a UNIQUE index on it from the clip
  // dedupe), and two blank notes have identical content — so notes salt it with the
  // row's own identity rather than hashing content alone.
  const hash = contentHash('note', `${now}:${Math.random()}:${content}`)
  const res = db
    .prepare(
      `INSERT INTO items (kind, content, hash, preview, created_at, last_copied_at,
         updated_at, title, secret, char_count)
       VALUES ('note', @content, @hash, @preview, @now, @now, @now, @title, 0, @chars)`
    )
    .run({
      content,
      hash,
      preview: content.slice(0, 500),
      now,
      title,
      chars: content.length
    })
  const id = Number(res.lastInsertRowid)
  syncLinks(id, content)
  return id
}

export function updateNote(id: number, patch: { title?: string; content?: string }): void {
  const db = getDb()
  const existing = db.prepare("SELECT content, title FROM items WHERE id = ? AND kind = 'note'").get(id) as
    | { content: string; title: string | null }
    | undefined
  if (!existing) return

  const content = patch.content ?? existing.content
  const title = (patch.title ?? existing.title ?? '').trim() || deriveTitle(content)
  const now = Date.now()
  db.prepare(
    `UPDATE items SET content = @content, title = @title, preview = @preview,
       updated_at = @now, char_count = @chars, hash = @hash
     WHERE id = @id AND kind = 'note'`
  ).run({
    id,
    content,
    title,
    preview: content.slice(0, 500),
    now,
    chars: content.length,
    // Content changed, so the hash must too, or the clip-dedupe index would let a
    // later clip with this exact text collide with the note.
    hash: contentHash('note', `${id}:${content}`)
  })
  syncLinks(id, content)
}

export function getNote(id: number): Note | null {
  const r = getDb()
    .prepare("SELECT * FROM items WHERE id = ? AND kind = 'note'")
    .get(id) as Record<string, unknown> | undefined
  return r ? rowToNote(r) : null
}

/**
 * Notes for the sidebar. `q` is a plain substring match over title and body —
 * deliberately not FTS here, because this list updates on every keystroke and needs
 * to match partial words the way a filter does, not the way a search engine does.
 * The palette's FTS/semantic search remains the way to actually *find* things.
 */
export function listNotes(opts: { q?: string; limit?: number } = {}): NoteSummary[] {
  const db = getDb()
  const limit = opts.limit ?? 500
  const q = opts.q?.trim()
  const rows = q
    ? (db
        .prepare(
          `SELECT id, title, preview, created_at, updated_at, pinned, tags FROM items
           WHERE kind = 'note' AND (title LIKE @like OR content LIKE @like)
           ORDER BY pinned DESC, updated_at DESC LIMIT @limit`
        )
        .all({ like: `%${q}%`, limit }) as Record<string, unknown>[])
    : (db
        .prepare(
          `SELECT id, title, preview, created_at, updated_at, pinned, tags FROM items
           WHERE kind = 'note' ORDER BY pinned DESC, updated_at DESC LIMIT ?`
        )
        .all(limit) as Record<string, unknown>[])

  return rows.map((r) => ({
    id: r.id as number,
    title: (r.title as string) ?? '',
    preview: (r.preview as string) ?? '',
    createdAt: r.created_at as number,
    updatedAt: (r.updated_at as number) ?? (r.created_at as number),
    pinned: !!r.pinned,
    tags: JSON.parse((r.tags as string) ?? '[]') as string[]
  }))
}

/**
 * Rewrite this note's outgoing edges.
 *
 * Delete-then-insert rather than diffing: a note has a handful of links, and the
 * whole point is that the body is the source of truth — a link removed from the text
 * must not survive in the index.
 */
export function syncLinks(fromId: number, body: string): void {
  const db = getDb()
  const targets = parseWikilinks(body)
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM note_links WHERE from_id = ?').run(fromId)
    if (targets.length === 0) return
    const insert = db.prepare(
      `INSERT OR REPLACE INTO note_links (from_id, to_id, target_title)
       VALUES (?, (SELECT id FROM items WHERE kind = 'note' AND lower(title) = lower(?) LIMIT 1), ?)`
    )
    for (const t of targets) insert.run(fromId, t, t)
  })
  tx()
}

/**
 * Attach edges that were pointing at this title before a note with it existed.
 *
 * Without this, writing `[[Reading list]]` and *then* creating that note leaves the
 * link permanently unresolved — the backlink would never appear, which reads as the
 * feature being broken.
 */
export function resolveLinksTo(id: number, title: string): void {
  getDb()
    .prepare('UPDATE note_links SET to_id = ? WHERE to_id IS NULL AND lower(target_title) = lower(?)')
    .run(id, title)
}

/** Notes that link *to* this one — the reverse-adjacency view. */
export function backlinks(id: number): NoteSummary[] {
  const rows = getDb()
    .prepare(
      `SELECT i.id, i.title, i.preview, i.created_at, i.updated_at, i.pinned, i.tags
       FROM note_links l JOIN items i ON i.id = l.from_id
       WHERE l.to_id = ? AND i.kind = 'note'
       ORDER BY i.updated_at DESC`
    )
    .all(id) as Record<string, unknown>[]
  return rows.map((r) => ({
    id: r.id as number,
    title: (r.title as string) ?? '',
    preview: (r.preview as string) ?? '',
    createdAt: r.created_at as number,
    updatedAt: (r.updated_at as number) ?? (r.created_at as number),
    pinned: !!r.pinned,
    tags: JSON.parse((r.tags as string) ?? '[]') as string[]
  }))
}

/** Outgoing links, including ones whose target note does not exist yet. */
export function outgoingLinks(id: number): Array<{ title: string; toId: number | null }> {
  const rows = getDb()
    .prepare('SELECT target_title, to_id FROM note_links WHERE from_id = ? ORDER BY target_title')
    .all(id) as Array<{ target_title: string; to_id: number | null }>
  return rows.map((r) => ({ title: r.target_title, toId: r.to_id }))
}

export function findNoteByTitle(title: string): number | null {
  const r = getDb()
    .prepare("SELECT id FROM items WHERE kind = 'note' AND lower(title) = lower(?) LIMIT 1")
    .get(title) as { id: number } | undefined
  return r?.id ?? null
}

/**
 * Today's daily note, created on first use.
 *
 * The zero-friction capture target: there is always somewhere to put a thought
 * without first deciding where it belongs.
 */
export function dailyNote(now = new Date()): number {
  const title = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const existing = findNoteByTitle(title)
  if (existing) return existing
  const id = createNote({ title, content: `# ${title}\n\n` })
  resolveLinksTo(id, title)
  return id
}
