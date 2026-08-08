import { app, utilityProcess, type UtilityProcess } from 'electron'
import { join } from 'path'
import { mkdirSync, writeFileSync, existsSync, createWriteStream } from 'fs'
import { createHash } from 'crypto'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { pipeline as streamPipeline } from 'stream/promises'
import { Readable } from 'stream'
import { getSettings } from './settings'
import { openaiTranscribe } from './modelport/openaiCompat'
import { macDecodeAudio } from './mac/helper'
import { audioExtension } from './audioFormat'

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

/**
 * Persist a recording; returns its path.
 *
 * The extension is load-bearing on macOS: AVFoundation infers the container from it,
 * and an mp4 written as `.wav` fails to open. mp4 is what darwin records now.
 */
export function saveRecording(audio: Buffer, mime: string): string {
  const ext = audioExtension(mime)
  const sha = createHash('sha256').update(audio).digest('hex').slice(0, 16)
  const file = join(audioDir(), `${Date.now()}-${sha}.${ext}`)
  writeFileSync(file, audio)
  return file
}

/**
 * Decode any container to 16k mono WAV — sherpa wants raw samples.
 *
 * Linux has ffmpeg (a documented dependency). macOS does not ship it and most users
 * won't have it, so darwin decodes through the Swift helper's AVFoundation path
 * instead. AVFoundation reads m4a/AAC, mp3, wav, aiff and caf but NOT WebM/Opus,
 * which is why the renderer records mp4/AAC on darwin — see lib/audio.ts.
 *
 * ffmpeg is still tried as a fallback on macOS: a user who has it (Homebrew) can
 * then still transcribe an old WebM recording from before that change.
 */
async function decodeToWav(path: string): Promise<string> {
  const wav = path.replace(/\.[^.]+$/, '.16k.wav')
  if (process.platform === 'darwin') {
    try {
      await macDecodeAudio(path, wav)
      return wav
    } catch (err) {
      console.error('[transcribe] AVFoundation decode failed, trying ffmpeg:', err)
      if (!(await ffmpegAvailable())) {
        throw new Error(
          `could not decode ${path.split('.').pop()} audio: ${err instanceof Error ? err.message : String(err)}`
        )
      }
    }
  }
  await execFileP('ffmpeg', ['-y', '-loglevel', 'error', '-i', path, '-ar', '16000', '-ac', '1', wav])
  return wav
}

let ffmpegPresent: boolean | null = null
async function ffmpegAvailable(): Promise<boolean> {
  if (ffmpegPresent !== null) return ffmpegPresent
  try {
    await execFileP('ffmpeg', ['-version'], { timeout: 3000 })
    ffmpegPresent = true
  } catch {
    ffmpegPresent = false
  }
  return ffmpegPresent
}

/**
 * Inference runs in a utilityProcess: it's a synchronous native call of several
 * seconds plus a ~490MB model load, which would freeze every window if it ran on
 * the main thread. The worker is spawned per transcription and exits after, so the
 * weights don't sit resident between dictations.
 */
let asrWorker: UtilityProcess | null = null
let asrSeq = 0
const asrPending = new Map<number, { resolve: (t: string) => void; reject: (e: Error) => void }>()

function ensureAsrWorker(): UtilityProcess {
  if (asrWorker) return asrWorker
  asrWorker = utilityProcess.fork(join(__dirname, 'asrWorker.mjs'), [], {
    serviceName: 'clipmd-asr'
  })
  asrWorker.on('message', (m: { type: string; id: number; text?: string; error?: string }) => {
    const p = asrPending.get(m.id)
    if (!p) return
    asrPending.delete(m.id)
    if (m.type === 'text') p.resolve((m.text ?? '').trim())
    else p.reject(new Error(m.error ?? 'transcription failed'))
  })
  asrWorker.on('exit', () => {
    asrWorker = null
    for (const [, p] of asrPending) p.reject(new Error('transcription worker exited'))
    asrPending.clear()
  })
  return asrWorker
}

async function localTranscribe(path: string): Promise<string> {
  if (!(await ensureLocalModel())) throw new Error('local model unavailable')
  const wav = await decodeToWav(path)
  const worker = ensureAsrWorker()
  const id = ++asrSeq
  const text = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      asrPending.delete(id)
      reject(new Error('transcription timed out'))
    }, 120_000)
    asrPending.set(id, {
      resolve: (t) => {
        clearTimeout(timer)
        resolve(t)
      },
      reject: (e) => {
        clearTimeout(timer)
        reject(e)
      }
    })
    worker.postMessage({ type: 'transcribe', id, wavPath: wav, modelDir: modelDir() })
  })
  // Release the model between dictations rather than holding it resident.
  setTimeout(() => {
    if (asrPending.size === 0 && asrWorker) asrWorker.kill()
  }, 30_000)
  return text
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
