import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { PortRequest } from './modelport'

const settings = { enrichment: { enabled: true }, linkEnrichment: true, apiKeys: {} }
vi.mock('./settings', () => ({ getSettings: () => settings, onSettingsChanged: () => () => {} }))

const requests: PortRequest[] = []
let respond: (req: PortRequest) => unknown = () => ({})
vi.mock('./modelport', async () => {
  const real = await vi.importActual<typeof import('./modelport/openaiCompat')>('./modelport/openaiCompat')
  return {
    ProviderError: real.ProviderError,
    describeProviderError: (e: { kind: string }) => `test ${e.kind}`,
    completeJson: async (_f: string, req: PortRequest) => {
      requests.push(req)
      return respond(req)
    }
  }
})
let ocrText = ''
vi.mock('./ocr', () => ({ ocrImage: async () => ocrText }))

const { openDb, closeDb, getDb } = await import('./store/db')
const items = await import('./store/items')
const { drain, enrichmentOutage, resumeEnrichment } = await import('./enrichment')
const { ProviderError } = await import('./modelport/openaiCompat')

let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'clipmd-enrich-'))
  openDb(dir)
})
afterAll(() => {
  closeDb()
  rmSync(dir, { recursive: true, force: true })
})
beforeEach(async () => {
  // Empty queue, breaker closed.
  getDb().exec('DELETE FROM enrich_queue')
  await resumeEnrichment()
  requests.length = 0
})

function clip(content: string, kind: 'text' | 'image' = 'text'): number {
  const { id } = items.upsertClip({ kind, content, preview: content, secret: false })
  items.enqueueEnrichment(id)
  return id
}

describe('enrichment', () => {
  it('does not charge items for a provider outage, and pauses the queue', async () => {
    const id = clip('some text while the key is bad')
    respond = () => {
      throw new ProviderError('openai', 'key-invalid', 'HTTP 401')
    }
    await drain()
    expect(enrichmentOutage()).toBe('test key-invalid')
    const row = items.nextEnrichQueueBatch(100).find((i) => i.id === id)
    expect(row).toBeDefined() // still queued, attempts untouched
    expect(items.enrichQueueStats().failed).toBe(0)
  })

  it('tags text clips in one batched call and clears the outage', async () => {
    const a = clip('SELECT 1')
    const b = clip('npm ERR! ERESOLVE')
    respond = (req) => {
      const ids = [...req.prompt.matchAll(/<snippet id="(\d+)">/g)].map((m) => Number(m[1]))
      return { items: ids.map((id) => ({ id, title: `t${id}`, tags: ['x'], content_class: 'code', language: null })) }
    }
    await drain()
    expect(requests).toHaveLength(1)
    expect(items.getItem(a)!.autoTitle).toBe(`t${a}`)
    expect(items.getItem(b)!.tags).toEqual(['x'])
    expect(enrichmentOutage()).toBeUndefined()
    expect(items.enrichQueueStats().queued).toBe(0)
  })

  it('reads screenshots locally and sends only the text, never the image', async () => {
    ocrText = 'Deploy failed: connection refused'
    const id = clip(join(dir, 'shot.png'), 'image')
    respond = () => ({ title: 'Deploy failure', tags: ['deploy'], content_class: 'screenshot', language: null })
    await drain()
    expect(requests).toHaveLength(1)
    expect(requests[0].imagePath).toBeUndefined()
    expect(requests[0].prompt).toContain('connection refused')
    const item = items.getItem(id)!
    expect(item.ocrText).toBe('Deploy failed: connection refused')
    expect(item.autoTitle).toBe('Deploy failure')
  })

  it('stores no tags for an image with no text, and makes no call', async () => {
    ocrText = ''
    const id = clip(join(dir, 'photo.png'), 'image')
    await drain()
    expect(requests).toHaveLength(0)
    const item = items.getItem(id)!
    expect(item.tags).toEqual([])
    expect(item.enrichedAt).toBeDefined()
    expect(items.enrichQueueStats().queued).toBe(0)
  })
})
