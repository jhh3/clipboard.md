/**
 * Embedding worker (Electron utilityProcess): hosts bge-small-en-v1.5 via
 * transformers.js/onnxruntime so tokenization and inference never block main.
 * Model (~34MB quantized) downloads to cacheDir on first use, then runs offline.
 *
 * Protocol: {type:'warm', cacheDir} -> {type:'warm', ms}
 *           {type:'embed', id, text, priority} -> {type:'vector', id, vector: number[]}
 *           {type:'embed-error', id, error} on failure.
 *
 * Requests run one at a time; priority (search query) requests go before background
 * ones, so typing never waits behind a backlog.
 */

type Extractor = (text: string, opts: { pooling: 'mean'; normalize: boolean }) => Promise<{
  data: Float32Array
}>

type Job = { type: 'embed'; id: number; text: string; cacheDir: string; priority?: boolean }

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
    extractorPromise.catch(() => (extractorPromise = null))
  }
  return extractorPromise
}

const urgent: Job[] = []
const background: Job[] = []
let busy = false

async function pump(): Promise<void> {
  if (busy) return
  busy = true
  try {
    for (let job = urgent.shift() ?? background.shift(); job; job = urgent.shift() ?? background.shift()) {
      try {
        const extractor = await getExtractor(job.cacheDir)
        // bge models embed queries and passages symmetrically enough for our scale.
        const out = await extractor(job.text.slice(0, 2000), { pooling: 'mean', normalize: true })
        process.parentPort.postMessage({ type: 'vector', id: job.id, vector: Array.from(out.data) })
      } catch (err) {
        process.parentPort.postMessage({
          type: 'embed-error',
          id: job.id,
          error: err instanceof Error ? err.message : String(err)
        })
      }
    }
  } finally {
    busy = false
  }
}

process.parentPort?.on('message', (e) => {
  const msg = e.data as Job | { type: 'warm'; cacheDir: string }
  if (msg.type === 'warm') {
    const started = Date.now()
    void getExtractor(msg.cacheDir)
      .then((x) => x('warm', { pooling: 'mean', normalize: true }))
      .then(() => process.parentPort.postMessage({ type: 'warm', ms: Date.now() - started }))
      .catch(() => {})
    return
  }
  if (msg.type === 'embed') {
    ;(msg.priority ? urgent : background).push(msg)
    void pump()
  }
})
