/**
 * OCR worker (Electron utilityProcess): runs the PaddleOCR models off the main thread.
 *
 * Protocol: {type:'ocr', id, path} -> {type:'text', id, text} | {type:'ocr-error', id, error}
 */
import models from '@gutenye/ocr-models/node'
import { recognize } from './engine'

process.parentPort?.on('message', (e) => {
  const msg = e.data as { type: 'ocr'; id: number; path: string }
  if (msg.type !== 'ocr') return
  const started = Date.now()
  recognize(models, msg.path)
    .then((text) => process.parentPort.postMessage({ type: 'text', id: msg.id, text, ms: Date.now() - started }))
    .catch((err) =>
      process.parentPort.postMessage({
        type: 'ocr-error',
        id: msg.id,
        error: err instanceof Error ? err.message : String(err)
      })
    )
})
