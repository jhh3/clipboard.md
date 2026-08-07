import { app, utilityProcess, type UtilityProcess } from 'electron'
import { join } from 'path'
import { itemsNeedingEmbedding, storeEmbedding } from '../store/items'
import { getSettings } from '../settings'
import { hasVec } from '../store/db'

/**
 * Embedding manager: drives the utilityProcess worker, drains un-embedded items in
 * the background, and answers query-embedding requests for hybrid search (with a
 * short timeout so search never blocks on a cold model).
 */

let worker: UtilityProcess | null = null
let seq = 0
const pending = new Map<number, { resolve: (v: Float32Array | null) => void; timer: NodeJS.Timeout }>()
let drainTimer: ReturnType<typeof setInterval> | null = null
let ready = false

function cacheDir(): string {
  return join(app.getPath('userData'), 'models')
}

export function startEmbeddings(): void {
  if (!hasVec() || !getSettings().embeddings.enabled) return
  if (worker) return
  worker = utilityProcess.fork(join(__dirname, 'embedWorker.mjs'), [], {
    serviceName: 'clipmd-embeddings'
  })
  worker.on('message', (msg: { type: string; id?: number; vector?: number[]; error?: string }) => {
    if (msg.type === 'pong') ready = true
    if ((msg.type === 'vector' || msg.type === 'embed-error') && msg.id !== undefined) {
      const p = pending.get(msg.id)
      if (p) {
        clearTimeout(p.timer)
        pending.delete(msg.id)
        if (msg.type === 'vector' && msg.vector) p.resolve(new Float32Array(msg.vector))
        else {
          if (msg.error) console.error('[embed] worker error:', msg.error)
          p.resolve(null)
        }
      }
    }
  })
  worker.on('exit', () => {
    worker = null
    ready = false
    for (const [, p] of pending) {
      clearTimeout(p.timer)
      p.resolve(null)
    }
    pending.clear()
  })
  worker.postMessage({ type: 'ping' })
  if (!drainTimer) drainTimer = setInterval(() => void drainEmbeddings(), 20_000)
  setTimeout(() => void drainEmbeddings(), 5_000)
}

export function stopEmbeddings(): void {
  if (drainTimer) clearInterval(drainTimer)
  drainTimer = null
  worker?.kill()
  worker = null
}

export function embed(text: string, timeoutMs = 20_000): Promise<Float32Array | null> {
  if (!worker) return Promise.resolve(null)
  const id = ++seq
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      resolve(null)
    }, timeoutMs)
    pending.set(id, { resolve, timer })
    worker!.postMessage({ type: 'embed', id, text, cacheDir: cacheDir() })
  })
}

/** Query embedding for search: short timeout so a cold model degrades to keyword mode. */
export function embedQuery(text: string): Promise<Float32Array | null> {
  return embed(text, ready ? 1_500 : 300)
}

let draining = false
async function drainEmbeddings(): Promise<void> {
  if (draining || !worker) return
  draining = true
  try {
    const batch = itemsNeedingEmbedding(16)
    for (const item of batch) {
      const text = [item.autoTitle, item.kind === 'image' ? item.ocrText : item.content, item.tags.join(' ')]
        .filter(Boolean)
        .join('\n')
        .slice(0, 2000)
      if (!text.trim()) continue
      const vec = await embed(text)
      if (vec) {
        storeEmbedding(item.id, vec)
        ready = true
      } else break // worker cold or erroring; retry next tick
    }
  } finally {
    draining = false
  }
}
