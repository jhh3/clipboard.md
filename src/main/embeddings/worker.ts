/**
 * Embedding worker (Electron utilityProcess): hosts bge-small-en-v1.5 via
 * transformers.js/onnxruntime so tokenization and inference never block main.
 * Model (~34MB quantized) downloads to cacheDir on first use, then runs offline.
 *
 * Protocol: {type:'embed', id, text} -> {type:'vector', id, vector: number[]}
 *           {type:'embed-error', id, error} on failure.
 */

type Extractor = (text: string, opts: { pooling: 'mean'; normalize: boolean }) => Promise<{
  data: Float32Array
}>

let extractorPromise: Promise<Extractor> | null = null

function getExtractor(cacheDir: string): Promise<Extractor> {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const { pipeline, env } = await import('@huggingface/transformers')
      env.cacheDir = cacheDir
      const pipe = await pipeline('feature-extraction', 'Xenova/bge-small-en-v1.5', {
        dtype: 'q8'
      })
      return pipe as unknown as Extractor
    })()
  }
  return extractorPromise
}

process.parentPort?.on('message', (e) => {
  const msg = e.data as
    | { type: 'embed'; id: number; text: string; cacheDir: string }
    | { type: 'ping' }
  if (msg.type === 'ping') {
    process.parentPort.postMessage({ type: 'pong' })
    return
  }
  if (msg.type === 'embed') {
    void (async () => {
      try {
        const extractor = await getExtractor(msg.cacheDir)
        // bge models embed queries and passages symmetrically enough for our scale.
        const out = await extractor(msg.text.slice(0, 2000), { pooling: 'mean', normalize: true })
        process.parentPort.postMessage({
          type: 'vector',
          id: msg.id,
          vector: Array.from(out.data)
        })
      } catch (err) {
        process.parentPort.postMessage({
          type: 'embed-error',
          id: msg.id,
          error: err instanceof Error ? err.message : String(err)
        })
      }
    })()
  }
})
