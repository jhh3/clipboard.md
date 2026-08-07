import { app } from 'electron'
import { join } from 'path'
import { mkdirSync, writeFileSync, existsSync, createWriteStream } from 'fs'
import { createHash } from 'crypto'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { pipeline as streamPipeline } from 'stream/promises'
import { Readable } from 'stream'
import { getSettings } from './settings'
import { openaiTranscribe } from './modelport/openaiCompat'

const execFileP = promisify(execFile)

/**
 * Transcription with two backends:
 *  - 'local': NVIDIA Parakeet TDT 0.6B v3 (int8) via sherpa-onnx. Fully offline;
 *    ~25x faster than realtime on CPU. Model is fetched on first use (~490MB).
 *  - 'openai': gpt-4o-mini-transcribe (cloud fallback / no model download).
 *
 * Recordings are always written to disk first so a failed transcript can be retried
 * without asking the user to speak again.
 */

const MODEL_URL =
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2'
const MODEL_DIR_NAME = 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8'

export function audioDir(): string {
  const dir = join(app.getPath('userData'), 'data', 'audio')
  mkdirSync(dir, { recursive: true })
  return dir
}

function modelRoot(): string {
  return join(app.getPath('userData'), 'models')
}

function modelDir(): string {
  return join(modelRoot(), MODEL_DIR_NAME)
}

export function localModelReady(): boolean {
  return existsSync(join(modelDir(), 'encoder.int8.onnx'))
}

let downloading: Promise<boolean> | null = null

/** Fetch + extract the Parakeet model once. Returns false if unavailable. */
export async function ensureLocalModel(): Promise<boolean> {
  if (localModelReady()) return true
  if (downloading) return downloading
  downloading = (async () => {
    try {
      const root = modelRoot()
      mkdirSync(root, { recursive: true })
      const archive = join(root, 'parakeet.tar.bz2')
      console.log('[transcribe] downloading Parakeet model (~490MB, one time)…')
      const res = await fetch(MODEL_URL)
      if (!res.ok || !res.body) throw new Error(`download HTTP ${res.status}`)
      await streamPipeline(Readable.fromWeb(res.body as never), createWriteStream(archive))
      // tar is present on both target platforms and handles bz2 via -j.
      await execFileP('tar', ['xjf', archive, '-C', root])
      console.log('[transcribe] Parakeet model ready')
      return localModelReady()
    } catch (err) {
      console.error('[transcribe] local model setup failed:', err)
      return false
    } finally {
      downloading = null
    }
  })()
  return downloading
}

/** Persist a recording; returns its path. */
export function saveRecording(audio: Buffer, mime: string): string {
  const ext = mime.includes('webm') ? 'webm' : mime.includes('ogg') ? 'ogg' : 'wav'
  const sha = createHash('sha256').update(audio).digest('hex').slice(0, 16)
  const file = join(audioDir(), `${Date.now()}-${sha}.${ext}`)
  writeFileSync(file, audio)
  return file
}

/** Decode any container to 16k mono PCM via ffmpeg (sherpa needs raw samples). */
async function decodeToPcm(path: string): Promise<{ samples: Float32Array; sampleRate: number }> {
  const wav = path.replace(/\.[^.]+$/, '.16k.wav')
  await execFileP('ffmpeg', ['-y', '-loglevel', 'error', '-i', path, '-ar', '16000', '-ac', '1', wav])
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sherpa = require('sherpa-onnx-node') as {
    readWave: (p: string) => { samples: Float32Array; sampleRate: number }
  }
  return sherpa.readWave(wav)
}

let recognizer: unknown = null

function getRecognizer(): unknown {
  if (recognizer) return recognizer
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sherpa = require('sherpa-onnx-node') as {
    OfflineRecognizer: new (cfg: unknown) => unknown
  }
  const d = modelDir()
  recognizer = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: join(d, 'encoder.int8.onnx'),
        decoder: join(d, 'decoder.int8.onnx'),
        joiner: join(d, 'joiner.int8.onnx')
      },
      tokens: join(d, 'tokens.txt'),
      numThreads: 4,
      provider: 'cpu',
      modelType: 'nemo_transducer',
      debug: false
    }
  })
  return recognizer
}

async function localTranscribe(path: string): Promise<string> {
  if (!(await ensureLocalModel())) throw new Error('local model unavailable')
  const { samples, sampleRate } = await decodeToPcm(path)
  const rec = getRecognizer() as {
    createStream: () => unknown
    decode: (s: unknown) => void
    getResult: (s: unknown) => { text: string }
  }
  const stream = rec.createStream() as { acceptWaveform: (w: unknown) => void }
  stream.acceptWaveform({ sampleRate, samples })
  rec.decode(stream)
  return rec.getResult(stream).text.trim()
}

/** Transcribe a saved recording using the configured backend, with fallback. */
export async function transcribeFile(path: string, audio?: Buffer, mime?: string): Promise<string> {
  const provider = getSettings().transcription.provider
  if (provider === 'local') {
    // No silent local→cloud fallback: choosing local transcription is a privacy
    // decision, and quietly uploading the recording would violate it.
    return localTranscribe(path)
  }
  const buf = audio ?? (await import('fs')).readFileSync(path)
  return (await openaiTranscribe(buf, mime ?? 'audio/webm')).trim()
}
