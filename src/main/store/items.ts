import { createHash } from 'crypto'
import type { ClipItem, ClipKind, SearchQuery, SearchResult } from '@shared/types'
import { getDb, hasVec, EMBEDDING_DIM } from './db'

interface ItemRow {
  id: number
  kind: string
  content: string
  html: string | null
  preview: string
  thumb: string | null
  width: number | null
  height: number | null
  source_app: string | null
  created_at: number
  last_copied_at: number
  copy_count: number
  pinned: number
  auto_title: string | null
  tags: string
  content_class: string | null
  ocr_text: string | null
  description: string | null
  language: string | null
  derived_from: number | null
  derived_via: string | null
  secret: number
  char_count: number
  enriched_at: number | null
  embedded_at: number | null
}

function rowToItem(r: ItemRow): ClipItem {
  return {
    id: r.id,
    kind: r.kind as ClipKind,
    content: r.content,
    html: r.html ?? undefined,
    preview: r.preview,
    thumb: r.thumb ?? undefined,
    width: r.width ?? undefined,
    height: r.height ?? undefined,
    sourceApp: r.source_app ?? undefined,
    createdAt: r.created_at,
    lastCopiedAt: r.last_copied_at,
    copyCount: r.copy_count,
    pinned: !!r.pinned,
    autoTitle: r.auto_title ?? undefined,
    tags: JSON.parse(r.tags),
    contentClass: (r.content_class as ClipItem['contentClass']) ?? undefined,
    ocrText: r.ocr_text ?? undefined,
    description: r.description ?? undefined,
    language: r.language ?? undefined,
    derivedFrom: r.derived_from ?? undefined,
    derivedVia: r.derived_via ?? undefined,
    secret: !!r.secret,
    charCount: r.char_count,
    enrichedAt: r.enriched_at ?? undefined,
    embeddedAt: r.embedded_at ?? undefined
  }
}

export function contentHash(kind: string, content: string): string {
  return createHash('sha256').update(kind).update('\0').update(content).digest('hex')
}

export interface NewClip {
  kind: ClipKind
  content: string
  html?: string
  preview: string
  thumb?: string
  width?: number
  height?: number
  sourceApp?: string
  secret: boolean
  derivedFrom?: number
  derivedVia?: string
}

/**
 * Insert a clip, or bump an existing identical clip back to the top (dedupe-on-recopy).
 * Returns the item id and whether it was newly created.
 */
export function upsertClip(clip: NewClip): { id: number; created: boolean } {
  const db = getDb()
  const hash = contentHash(clip.kind, clip.content)
  const now = Date.now()

  const existing = db.prepare('SELECT id FROM items WHERE hash = ?').get(hash) as
    | { id: number }
    | undefined
  if (existing) {
    db.prepare(
      'UPDATE items SET last_copied_at = ?, copy_count = copy_count + 1, source_app = COALESCE(?, source_app) WHERE id = ?'
    ).run(now, clip.sourceApp ?? null, existing.id)
    return { id: existing.id, created: false }
  }

  const res = db
    .prepare(
      `INSERT INTO items (kind, content, html, hash, preview, thumb, width, height, source_app,
        created_at, last_copied_at, secret, char_count, derived_from, derived_via)
       VALUES (@kind, @content, @html, @hash, @preview, @thumb, @width, @height, @sourceApp,
        @now, @now, @secret, @charCount, @derivedFrom, @derivedVia)`
    )
    .run({
      kind: clip.kind,
      content: clip.content,
      html: clip.html ?? null,
      hash,
      preview: clip.preview,
      thumb: clip.thumb ?? null,
      width: clip.width ?? null,
      height: clip.height ?? null,
      sourceApp: clip.sourceApp ?? null,
      now,
      secret: clip.secret ? 1 : 0,
      charCount: clip.content.length,
      derivedFrom: clip.derivedFrom ?? null,
      derivedVia: clip.derivedVia ?? null
    })
  return { id: Number(res.lastInsertRowid), created: true }
}

export function getItem(id: number): ClipItem | null {
  const r = getDb().prepare('SELECT * FROM items WHERE id = ?').get(id) as ItemRow | undefined
  return r ? rowToItem(r) : null
}

export function setPinned(id: number, pinned: boolean): void {
  getDb().prepare('UPDATE items SET pinned = ? WHERE id = ?').run(pinned ? 1 : 0, id)
}

export function deleteItem(id: number): void {
  const db = getDb()
  if (hasVec()) db.prepare('DELETE FROM items_vec WHERE item_id = ?').run(id)
  db.prepare('DELETE FROM items WHERE id = ?').run(id)
}

export function updateEnrichment(
  id: number,
  patch: {
    autoTitle?: string
    tags?: string[]
    contentClass?: string
    ocrText?: string
    description?: string
    language?: string
  }
): void {
  getDb()
    .prepare(
      `UPDATE items SET
        auto_title = COALESCE(@autoTitle, auto_title),
        tags = COALESCE(@tags, tags),
        content_class = COALESCE(@contentClass, content_class),
        ocr_text = COALESCE(@ocrText, ocr_text),
        description = COALESCE(@description, description),
        language = COALESCE(@language, language),
        enriched_at = @now
       WHERE id = @id`
    )
    .run({
      id,
      autoTitle: patch.autoTitle ?? null,
      tags: patch.tags ? JSON.stringify(patch.tags) : null,
      contentClass: patch.contentClass ?? null,
      ocrText: patch.ocrText ?? null,
      description: patch.description ?? null,
      language: patch.language ?? null,
      now: Date.now()
    })
}

export function storeEmbedding(id: number, vector: Float32Array): void {
  if (!hasVec()) return
  if (vector.length !== EMBEDDING_DIM) throw new Error(`expected ${EMBEDDING_DIM}-d vector`)
  const db = getDb()
  db.prepare('DELETE FROM items_vec WHERE item_id = ?').run(id)
  // better-sqlite3 v13 binds JS numbers as REAL; vec0 requires a true INTEGER pk.
  db.prepare('INSERT INTO items_vec (item_id, embedding) VALUES (?, ?)').run(
    BigInt(id),
    Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength)
  )
  db.prepare('UPDATE items SET embedded_at = ? WHERE id = ?').run(Date.now(), id)
}

/** Escape user input for an FTS5 MATCH: quote each token, keep prefix matching on the last. */
function ftsQuery(q: string): string {
  const tokens = q
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
  if (tokens.length === 0) return ''
  tokens[tokens.length - 1] += '*'
  return tokens.join(' ')
}

function filterClauses(q: SearchQuery): { where: string; params: Record<string, unknown> } {
  const clauses: string[] = []
  const params: Record<string, unknown> = {}
  if (q.kind && q.kind !== 'all') {
    if (q.kind === 'link' || q.kind === 'code' || q.kind === 'color') {
      // These are classification facets over text clips, not raw kinds.
      clauses.push("(kind = @kind OR content_class = @kind)")
    } else {
      clauses.push('kind = @kind')
    }
    params.kind = q.kind
  }
  if (q.collection === 'pinned') clauses.push('pinned = 1')
  else if (q.collection) {
    clauses.push(
      "(content_class = @coll OR EXISTS (SELECT 1 FROM json_each(items.tags) je WHERE je.value = @coll))"
    )
    params.coll = q.collection
  }
  return { where: clauses.length ? 'AND ' + clauses.join(' AND ') : '', params }
}

export function searchKeyword(q: SearchQuery): SearchResult {
  const db = getDb()
  const limit = q.limit ?? 100
  const offset = q.offset ?? 0
  const { where, params } = filterClauses(q)

  if (!q.q.trim()) {
    const rows = db
      .prepare(
        `SELECT * FROM items WHERE 1=1 ${where}
         ORDER BY pinned DESC, last_copied_at DESC LIMIT @limit OFFSET @offset`
      )
      .all({ ...params, limit, offset }) as ItemRow[]
    const total = (
      db.prepare(`SELECT COUNT(*) c FROM items WHERE 1=1 ${where}`).get(params) as { c: number }
    ).c
    return { items: rows.map(rowToItem), total, mode: 'keyword' }
  }

  const match = ftsQuery(q.q)
  const rows = db
    .prepare(
      `SELECT items.* FROM items_fts
       JOIN items ON items.id = items_fts.rowid
       WHERE items_fts MATCH @match ${where}
       ORDER BY items.pinned DESC, bm25(items_fts, 5.0, 10.0, 3.0, 4.0, 2.0)
       LIMIT @limit OFFSET @offset`
    )
    .all({ ...params, match, limit, offset }) as ItemRow[]
  return { items: rows.map(rowToItem), total: rows.length, mode: 'keyword' }
}

/**
 * Hybrid search: FTS5 BM25 top-K fused with vector KNN top-K via Reciprocal Rank Fusion.
 * Falls back to keyword when vectors are unavailable or the query embedding is missing.
 */
export function searchHybrid(q: SearchQuery, queryEmbedding: Float32Array | null): SearchResult {
  if (!hasVec() || !queryEmbedding) return searchKeyword(q)
  const db = getDb()
  const K = 50
  const limit = q.limit ?? 100
  const { where, params } = filterClauses(q)

  const match = ftsQuery(q.q)
  const ftsRows = match
    ? (db
        .prepare(
          `SELECT items.id FROM items_fts JOIN items ON items.id = items_fts.rowid
           WHERE items_fts MATCH @match ${where}
           ORDER BY bm25(items_fts, 5.0, 10.0, 3.0, 4.0, 2.0) LIMIT ${K}`
        )
        .all({ ...params, match }) as Array<{ id: number }>)
    : []

  const vecRows = db
    .prepare(
      `SELECT item_id AS id FROM items_vec
       WHERE embedding MATCH ? AND k = ${K}
       ORDER BY distance`
    )
    .all(
      Buffer.from(queryEmbedding.buffer, queryEmbedding.byteOffset, queryEmbedding.byteLength)
    ) as Array<{ id: number }>

  const rrf = new Map<number, number>()
  const RRF_K = 60
  ftsRows.forEach((r, i) => rrf.set(r.id, (rrf.get(r.id) ?? 0) + 1 / (RRF_K + i + 1)))
  vecRows.forEach((r, i) => rrf.set(r.id, (rrf.get(r.id) ?? 0) + 1 / (RRF_K + i + 1)))

  const ranked = [...rrf.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit)
  if (ranked.length === 0) return searchKeyword(q)

  const placeholders = ranked.map(() => '?').join(',')
  const rows = db
    .prepare(`SELECT * FROM items WHERE id IN (${placeholders})`)
    .all(...ranked.map(([id]) => id)) as ItemRow[]
  const byId = new Map(rows.map((r) => [r.id, r]))
  const items = ranked
    .map(([id]) => byId.get(id))
    .filter((r): r is ItemRow => !!r)
    .map(rowToItem)
  return { items, total: items.length, mode: 'hybrid' }
}

/** Items awaiting enrichment/embedding, oldest first. */
export function nextEnrichQueueBatch(limit: number): ClipItem[] {
  const rows = getDb()
    .prepare(
      `SELECT items.* FROM enrich_queue JOIN items ON items.id = enrich_queue.item_id
       WHERE enrich_queue.attempts < 3 ORDER BY enrich_queue.queued_at ASC LIMIT ?`
    )
    .all(limit) as ItemRow[]
  return rows.map(rowToItem)
}

export function enqueueEnrichment(itemId: number): void {
  getDb()
    .prepare('INSERT OR IGNORE INTO enrich_queue (item_id, queued_at) VALUES (?, ?)')
    .run(itemId, Date.now())
}

export function dequeueEnrichment(itemId: number, error?: string): void {
  const db = getDb()
  if (error) {
    db.prepare(
      'UPDATE enrich_queue SET attempts = attempts + 1, last_error = ? WHERE item_id = ?'
    ).run(error, itemId)
  } else {
    db.prepare('DELETE FROM enrich_queue WHERE item_id = ?').run(itemId)
  }
}

export function enrichQueueStats(): { queued: number; failed: number } {
  const db = getDb()
  const queued = (db.prepare('SELECT COUNT(*) c FROM enrich_queue WHERE attempts < 3').get() as {
    c: number
  }).c
  const failed = (db.prepare('SELECT COUNT(*) c FROM enrich_queue WHERE attempts >= 3').get() as {
    c: number
  }).c
  return { queued, failed }
}

/** Items with no embedding yet (for the background embedder). Secret items excluded. */
export function itemsNeedingEmbedding(limit: number): ClipItem[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM items
       WHERE embedded_at IS NULL AND secret = 0 AND kind != 'image' OR
             (kind = 'image' AND embedded_at IS NULL AND secret = 0 AND ocr_text IS NOT NULL)
       ORDER BY last_copied_at DESC LIMIT ?`
    )
    .all(limit) as ItemRow[]
  return rows.map(rowToItem)
}

/** Retention: delete unpinned items older than cutoff, and enforce max count. */
export function applyRetention(retentionDays: number, maxItems: number): number {
  const db = getDb()
  const cutoff = Date.now() - retentionDays * 86_400_000
  const r1 = db
    .prepare('DELETE FROM items WHERE pinned = 0 AND last_copied_at < ?')
    .run(cutoff)
  const r2 = db
    .prepare(
      `DELETE FROM items WHERE pinned = 0 AND id IN (
         SELECT id FROM items WHERE pinned = 0
         ORDER BY last_copied_at DESC LIMIT -1 OFFSET ?)`
    )
    .run(maxItems)
  return r1.changes + r2.changes
}

export function exportAll(): ClipItem[] {
  const rows = getDb().prepare('SELECT * FROM items ORDER BY id').all() as ItemRow[]
  return rows.map(rowToItem)
}
