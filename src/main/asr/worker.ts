/**
 * ASR worker (utilityProcess). Parakeet inference is a synchronous native call that
 * takes seconds and loads ~490MB of weights — doing that on the Electron main thread
 * stalls every window and gets the app declared unresponsive (DESIGN.md §2 rule 2).
 *
 * Protocol: {type:'transcribe', id, wavPath, modelDir} -> {type:'text', id, text}
 *           {type:'error', id, error}
 */

let recognizer: unknown = null
let loadedFrom = ''

function getRecognizer(modelDir: string): unknown {
  if (recognizer && loadedFrom === modelDir) return recognizer
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sherpa = require('sherpa-onnx-node') as { OfflineRecognizer: new (c: unknown) => unknown }
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

process.parentPort?.on('message', (e) => {
  const msg = e.data as { type: string; id?: number; wavPath?: string; modelDir?: string }
  if (msg.type === 'transcribe' && msg.id !== undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const sherpa = require('sherpa-onnx-node') as {
        readWave: (
          p: string,
          enableExternalBuffer?: boolean
        ) => { samples: Float32Array; sampleRate: number }
      }
      const rec = getRecognizer(msg.modelDir!) as {
        createStream: () => unknown
        decode: (s: unknown) => void
        getResult: (s: unknown) => { text: string }
      }
      // enableExternalBuffer MUST be false here: this runs inside an Electron
      // utilityProcess, and Electron's V8 memory cage forbids napi external
      // buffers — the default path throws "External buffers are not allowed"
      // the moment a wave is read. False makes the binding copy instead.
      const wave = sherpa.readWave(msg.wavPath!, false)
      const stream = rec.createStream() as { acceptWaveform: (w: unknown) => void }
      stream.acceptWaveform({ sampleRate: wave.sampleRate, samples: wave.samples })
      rec.decode(stream)
      process.parentPort.postMessage({ type: 'text', id: msg.id, text: rec.getResult(stream).text })
    } catch (err) {
      process.parentPort.postMessage({
        type: 'error',
        id: msg.id,
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }
})
