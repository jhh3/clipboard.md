import { app, utilityProcess, type UtilityProcess } from 'electron'
import { join } from 'path'
import { itemsNeedingEmbedding, storeEmbedding, markEmbeddingSkipped } from '../store/items'
import { getSettings } from '../settings'
import { hasVec } from '../store/db'

/**
 * Embedding manager: drives the utilityProcess worker, drains un-embedded items in
 * the background, and answers query embeddings for hybrid search.
 *
 * The worker stays loaded (~140 MB). Unloading after 5 min idle made the first
 * search after every break keyword-only, 171 times in one week; reloading costs more
 * than the memory is worth. Query embeddings jump the worker's queue ahead of
 * background batches.
 */

let worker: UtilityProcess | null = null
let seq = 0
const pending = new Map<number, { resolve: (v: Float32Array | null) => void; timer: NodeJS.Timeout }>()
let drainTimer: ReturnType<typeof setInterval> | null = null
let ready = false
let restarts = 0
const MAX_RESTARTS = 4
let intentionalStop = false

function cacheDir(): string {
  return join(app.getPath('userData'), 'models')
}

export function startEmbeddings(): void {
  if (!hasVec() || !getSettings().embeddings.enabled) return
  if (worker) return
  const w = utilityProcess.fork(join(__dirname, 'embedWorker.mjs'), [], {
    serviceName: 'clipmd-embeddings'
  })
  worker = w
  w.on('message', (msg: { type: string; id?: number; vector?: number[]; error?: string; ms?: number }) => {
    if (msg.type === 'warm') {
      ready = true
      console.log(`[embed] model loaded in ${msg.ms}ms`)
    }
    if ((msg.type === 'vector' || msg.type === 'embed-error') && msg.id !== undefined) {
      const p = pending.get(msg.id)
      if (!p) return
      clearTimeout(p.timer)
      pending.delete(msg.id)
      if (msg.type === 'vector' && msg.vector) {
        ready = true
        // Healthy again: an occasional crash should not add up to a permanent disable.
        restarts = 0
        p.resolve(new Float32Array(msg.vector))
      } else {
        if (msg.error) console.error('[embed] worker error:', msg.error)
        p.resolve(null)
      }
    }
  })
  w.on('exit', () => {
    if (worker === w) worker = null
    ready = false
    for (const [, p] of pending) {
      clearTimeout(p.timer)
      p.resolve(null)
    }
    pending.clear()
    if (intentionalStop) {
      intentionalStop = false
      return
    }
    // Respawn with backoff, but give up rather than crash-loop forever. The counter
    // resets on the next successful embedding.
    if (restarts < MAX_RESTARTS) {
      const delay = 5000 * 2 ** restarts
      restarts++
      console.error(`[embed] worker exited; restarting in ${delay}ms (attempt ${restarts})`)
      setTimeout(() => startEmbeddings(), delay)
    } else {
      console.error('[embed] worker exited too many times; semantic search off until restart')
    }
  })
  // Load the model now, so the first search is already warm.
  w.postMessage({ type: 'warm', cacheDir: cacheDir() })
  if (!drainTimer) drainTimer = setInterval(() => void drainEmbeddings(), 20_000)
  setTimeout(() => void drainEmbeddings(), 5_000)
}

export function stopEmbeddings(): void {
  if (drainTimer) clearInterval(drainTimer)
  drainTimer = null
  if (worker) intentionalStop = true
  worker?.kill()
  worker = null
}

/** Make sure the worker is up and the model loaded (palette open, after a crash). */
export function warmEmbeddings(): void {
  if (!worker) startEmbeddings()
}

function embed(text: string, timeoutMs: number, priority: boolean): Promise<Float32Array | null> {
  if (!worker) startEmbeddings()
  const w = worker
  if (!w) return Promise.resolve(null)
  const id = ++seq
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      resolve(null)
    }, timeoutMs)
    pending.set(id, { resolve, timer })
    w.postMessage({ type: 'embed', id, text, cacheDir: cacheDir(), priority })
  })
}

/** Query embedding for search. Waits out a cold start (~0.5 s) rather than giving up. */
export function embedQuery(text: string): Promise<Float32Array | null> {
  return embed(text, ready ? 2_000 : 5_000, true)
}

let draining = false
async function drainEmbeddings(): Promise<void> {
  if (draining || !worker) return
  if (!hasVec() || !getSettings().embeddings.enabled) return
  draining = true
  try {
    const batch = itemsNeedingEmbedding(16)
    for (const item of batch) {
      const text = [item.autoTitle, item.kind === 'image' ? item.ocrText : item.content, item.tags.join(' ')]
        .filter(Boolean)
        .join('\n')
        .slice(0, 2000)
      if (!text.trim()) {
        markEmbeddingSkipped(item.id) // otherwise this item blocks the queue forever
        continue
      }
      const vec = await embed(text, 20_000, false)
      if (!vec) break // worker cold or erroring; retry next tick
      try {
        storeEmbedding(item.id, vec)
      } catch (err) {
        console.error('[embed] store failed:', err)
        break
      }
    }
  } finally {
    draining = false
  }
}
