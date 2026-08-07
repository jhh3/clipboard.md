import { app, utilityProcess, type UtilityProcess } from 'electron'
import { join } from 'path'
import { itemsNeedingEmbedding, storeEmbedding, markEmbeddingSkipped } from '../store/items'
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
let restarts = 0
const MAX_RESTARTS = 4
/** Idle unload: the worker holds ~140MB of model weights; a background clipboard
 *  manager has no business keeping that resident between bursts of work. */
let lastUse = 0
let intentionalStop = false
const IDLE_UNLOAD_MS = 5 * 60_000

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
    if (intentionalStop) {
      intentionalStop = false
      return // idle unload, not a crash
    }
    // An onnxruntime OOM used to disable embeddings silently for the rest of the
    // session. Respawn with backoff, but give up rather than crash-loop forever.
    if (restarts < MAX_RESTARTS) {
      const delay = 5000 * 2 ** restarts
      restarts++
      console.error(`[embed] worker exited; restarting in ${delay}ms (attempt ${restarts})`)
      setTimeout(() => startEmbeddings(), delay)
    } else {
      console.error('[embed] worker exited too many times; semantic search disabled')
    }
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
  if (!worker) {
    // Woken by a query after an idle unload: spin the worker back up. This call
    // returns null (search degrades to keyword) and the next one will be warm.
    startEmbeddings()
    return Promise.resolve(null)
  }
  lastUse = Date.now()
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
      if (!text.trim()) {
        markEmbeddingSkipped(item.id) // otherwise this item blocks the queue forever
        continue
      }
      const vec = await embed(text)
      if (vec) {
        try {
          storeEmbedding(item.id, vec)
        } catch (err) {
          console.error('[embed] store failed:', err)
          break
        }
        ready = true
      } else break // worker cold or erroring; retry next tick
    }
    if (batch.length > 0) lastUse = Date.now()
  } finally {
    draining = false
  }

  // Nothing left to embed and nobody has searched in a while: release the model.
  if (worker && pending.size === 0 && Date.now() - lastUse > IDLE_UNLOAD_MS) {
    console.log('[embed] idle; unloading model to reclaim memory')
    intentionalStop = true
    worker.kill()
  }
}
