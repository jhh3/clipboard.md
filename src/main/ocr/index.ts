import { utilityProcess, type UtilityProcess } from 'electron'
import { join } from 'path'

/**
 * Screenshot OCR in a utilityProcess, started on first use and released after a
 * minute idle (OCR runs in bursts as screenshots arrive; the models are ~16 MB).
 */

let worker: UtilityProcess | null = null
let seq = 0
const pending = new Map<number, { resolve: (t: string) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()
let idleTimer: NodeJS.Timeout | null = null
const IDLE_MS = 60_000
const TIMEOUT_MS = 30_000

function ensureWorker(): UtilityProcess {
  if (worker) return worker
  const w = utilityProcess.fork(join(__dirname, 'ocrWorker.mjs'), [], { serviceName: 'clipmd-ocr' })
  w.on('message', (msg: { type: string; id: number; text?: string; error?: string; ms?: number }) => {
    const p = pending.get(msg.id)
    if (!p) return
    clearTimeout(p.timer)
    pending.delete(msg.id)
    if (msg.type === 'text') {
      console.log(`[ocr] ${msg.ms}ms, ${msg.text?.length ?? 0} chars`)
      p.resolve(msg.text ?? '')
    } else p.reject(new Error(`ocr failed: ${msg.error}`))
  })
  w.on('exit', () => {
    if (worker === w) worker = null
    for (const [, p] of pending) {
      clearTimeout(p.timer)
      p.reject(new Error('ocr worker exited'))
    }
    pending.clear()
  })
  worker = w
  return w
}

/** Text in the image at `path`, '' when there is none. */
export function ocrImage(path: string): Promise<string> {
  const w = ensureWorker()
  if (idleTimer) clearTimeout(idleTimer)
  const id = ++seq
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`ocr timed out after ${TIMEOUT_MS}ms`))
    }, TIMEOUT_MS)
    pending.set(id, { resolve, reject, timer })
    w.postMessage({ type: 'ocr', id, path })
  }).finally(() => {
    if (pending.size === 0) {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(stopOcr, IDLE_MS)
    }
  })
}

export function stopOcr(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
  worker?.kill()
  worker = null
}
