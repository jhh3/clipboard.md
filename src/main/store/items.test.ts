import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { openDb, closeDb, hasVec, EMBEDDING_DIM } from './db'
import {
  upsertClip,
  getItem,
  setPinned,
  deleteItem,
  searchKeyword,
  searchHybrid,
  storeEmbedding,
  updateEnrichment,
  enqueueEnrichment,
  dequeueEnrichment,
  enrichQueueStats,
  applyRetention,
  purgeItems
} from './items'

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'clipmd-test-'))
  openDb(dir)
})

afterAll(() => {
  closeDb()
  rmSync(dir, { recursive: true, force: true })
})

function textClip(content: string, extra: Partial<Parameters<typeof upsertClip>[0]> = {}) {
  return upsertClip({
    kind: 'text',
    content,
    preview: content.slice(0, 500),
    secret: false,
    ...extra
  })
}

describe('store', () => {
  it('inserts and reads back a clip', () => {
    const { id, created } = textClip('hello world')
    expect(created).toBe(true)
    const item = getItem(id)!
    expect(item.content).toBe('hello world')
    expect(item.pinned).toBe(false)
    expect(item.copyCount).toBe(1)
  })

  it('dedupes on re-copy and bumps to top', () => {
    const a = textClip('dedupe me')
    const b = textClip('dedupe me')
    expect(b.created).toBe(false)
    expect(b.id).toBe(a.id)
    expect(getItem(a.id)!.copyCount).toBe(2)
  })

  it('finds items via FTS with prefix matching', () => {
    textClip('postgres connection string for staging environment')
    const res = searchKeyword({ q: 'postgres conn' })
    expect(res.items.some((i) => i.preview.includes('postgres connection'))).toBe(true)
  })

  it('omits heavy fields from list results but keeps them on item:get', () => {
    // Guards the IPC payload: list rows must not carry full bodies (a 400-row
    // result was shipping tens of MB per keystroke).
    const big = 'x'.repeat(50_000)
    const { id } = textClip(big)
    const listed = searchKeyword({ q: '' }).items.find((i) => i.id === id)!
    expect(listed.content).toBe('')
    expect(listed.preview.length).toBeLessThanOrEqual(500)
    expect(getItem(id)!.content).toHaveLength(50_000)
  })

  it('purges image files and vectors, not just rows', () => {
    const file = join(dir, 'purge-me.png')
    writeFileSync(file, 'not-a-real-png')
    const { id } = upsertClip({
      kind: 'image',
      content: file,
      preview: 'Image 1x1',
      secret: false
    })
    const v = new Float32Array(EMBEDDING_DIM).fill(0)
    v[5] = 1
    storeEmbedding(id, v)
    purgeItems([id])
    expect(getItem(id)).toBeNull()
    expect(existsSync(file)).toBe(false)
  })

  it('excludes secret content from FTS index', () => {
    textClip('AKIA_SECRET_KEY_MATERIAL_XYZ', { secret: true })
    const res = searchKeyword({ q: 'AKIA_SECRET_KEY_MATERIAL' })
    expect(res.items.length).toBe(0)
  })

  it('searches enrichment fields (title, tags, ocr)', () => {
    const { id } = textClip('some opaque blob 12345')
    updateEnrichment(id, { autoTitle: 'Stripe webhook secret rotation notes', tags: ['stripe'] })
    const byTitle = searchKeyword({ q: 'webhook rotation' })
    expect(byTitle.items.map((i) => i.id)).toContain(id)
    const byTag = searchKeyword({ q: 'stripe' })
    expect(byTag.items.map((i) => i.id)).toContain(id)
  })

  it('pins float to top of empty-query listing', () => {
    const { id } = textClip('pinned thing')
    setPinned(id, true)
    const res = searchKeyword({ q: '' })
    expect(res.items[0].id).toBe(id)
  })

  it('filters by kind and collection facets', () => {
    const { id } = textClip('SELECT * FROM users;')
    updateEnrichment(id, { contentClass: 'code', language: 'sql' })
    const res = searchKeyword({ q: '', kind: 'code' })
    expect(res.items.map((i) => i.id)).toContain(id)
  })

  it('applies chip filters to semantic (vector) hits', () => {
    // Regression guard: the vector arm can't express filters, so hydration must.
    const { id } = textClip('a semantic-only match about kubernetes autoscaling')
    const v = new Float32Array(EMBEDDING_DIM).fill(0)
    v[3] = 1
    storeEmbedding(id, v)
    const q = new Float32Array(EMBEDDING_DIM).fill(0)
    q[3] = 1
    // Same query, filtered to images: the text hit must not come back.
    const res = searchHybrid({ q: 'kubernetes', kind: 'image' }, q)
    expect(res.items.map((i) => i.id)).not.toContain(id)
  })

  it('runs hybrid search with RRF when vectors exist', () => {
    expect(hasVec()).toBe(true)
    const { id } = textClip('the quarterly revenue forecast spreadsheet numbers')
    const v = new Float32Array(EMBEDDING_DIM).fill(0)
    v[0] = 1
    storeEmbedding(id, v)
    const q = new Float32Array(EMBEDDING_DIM).fill(0)
    q[0] = 1
    const res = searchHybrid({ q: 'revenue forecast' }, q)
    expect(res.mode).toBe('hybrid')
    expect(res.items[0].id).toBe(id)
  })

  it('manages the enrichment queue', () => {
    const { id } = textClip('enrich queue test item')
    enqueueEnrichment(id)
    expect(enrichQueueStats().queued).toBeGreaterThan(0)
    dequeueEnrichment(id, 'transient failure')
    dequeueEnrichment(id)
    expect(
      enrichQueueStats().queued + enrichQueueStats().failed
    ).toBe(0)
  })

  it('applies retention without touching pinned items', () => {
    const { id: pinnedId } = textClip('ancient pinned')
    setPinned(pinnedId, true)
    const { id: oldId } = textClip('ancient unpinned')
    const db = openDb(dir)
    db.prepare('UPDATE items SET last_copied_at = 1 WHERE id IN (?, ?)').run(pinnedId, oldId)
    applyRetention(30, 100000)
    expect(getItem(pinnedId)).not.toBeNull()
    expect(getItem(oldId)).toBeNull()
  })

  it('deletes items and their vectors', () => {
    const { id } = textClip('to be deleted')
    deleteItem(id)
    expect(getItem(id)).toBeNull()
  })
})
