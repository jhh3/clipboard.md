/**
 * ASR worker (utilityProcess). Parakeet inference is a synchronous native call that
 * takes seconds and loads ~490MB of weights — doing that on the Electron main thread
 * stalls every window and gets the app declared unresponsive (docs/DESIGN.md §2 rule 2).
 *
 * Protocol: {type:'load', modelDir} -> {type:'loaded', ms}
 *           {type:'transcribe', id, modelDir, samples|wavPath} -> {type:'text', id, text, ms}
 *           {type:'error', id, error}
 *
 * `samples` is 16 kHz mono Float32 PCM straight from the recorder, so the dictation
 * path never touches a file. `wavPath` remains for the macOS retry path, which
 * decodes an old recording through AVFoundation into a temporary WAV.
 */

interface Recognizer {
  createStream: () => { acceptWaveform: (w: { sampleRate: number; samples: Float32Array }) => void }
  decode: (s: unknown) => void
  getResult: (s: unknown) => { text: string }
}

let recognizer: Recognizer | null = null
let loadedFrom = ''

function getRecognizer(modelDir: string): Recognizer {
  if (recognizer && loadedFrom === modelDir) return recognizer
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sherpa = require('sherpa-onnx-node') as { OfflineRecognizer: new (c: unknown) => Recognizer }
  recognizer = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: `${modelDir}/encoder.int8.onnx`,
        decoder: `${modelDir}/decoder.int8.onnx`,
        joiner: `${modelDir}/joiner.int8.onnx`
      },
      tokens: `${modelDir}/tokens.txt`,
      numThreads: 4,
      provider: 'cpu',
      modelType: 'nemo_transducer',
      debug: false
    }
  })
  loadedFrom = modelDir
  return recognizer
}

function readWav(path: string): { samples: Float32Array; sampleRate: number } {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sherpa = require('sherpa-onnx-node') as {
    readWave: (p: string, enableExternalBuffer?: boolean) => { samples: Float32Array; sampleRate: number }
  }
  // enableExternalBuffer MUST be false here: this runs inside an Electron
  // utilityProcess, and Electron's V8 memory cage forbids napi external
  // buffers — the default path throws "External buffers are not allowed"
  // the moment a wave is read. False makes the binding copy instead.
  return sherpa.readWave(path, false)
}

process.parentPort?.on('message', (e) => {
  const msg = e.data as {
    type: string
    id?: number
    modelDir?: string
    samples?: Float32Array
    wavPath?: string
  }
  if (msg.type === 'load' && msg.modelDir) {
    const t0 = Date.now()
    try {
      getRecognizer(msg.modelDir)
      process.parentPort.postMessage({ type: 'loaded', ms: Date.now() - t0 })
    } catch (err) {
      process.parentPort.postMessage({ type: 'loadError', error: err instanceof Error ? err.message : String(err) })
    }
    return
  }
  if (msg.type === 'transcribe' && msg.id !== undefined) {
    const t0 = Date.now()
    try {
      const rec = getRecognizer(msg.modelDir!)
      const wave = msg.samples
        ? { sampleRate: 16000, samples: msg.samples }
        : readWav(msg.wavPath!)
      const stream = rec.createStream()
      stream.acceptWaveform(wave)
      rec.decode(stream)
      process.parentPort.postMessage({
        type: 'text',
        id: msg.id,
        text: rec.getResult(stream).text,
        ms: Date.now() - t0
      })
    } catch (err) {
      process.parentPort.postMessage({
        type: 'error',
        id: msg.id,
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }
})
