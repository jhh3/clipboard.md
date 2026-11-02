import { app, utilityProcess, type UtilityProcess } from 'electron'
import { join } from 'path'
import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync, readdirSync, statSync } from 'fs'
import { createHash } from 'crypto'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { Readable } from 'stream'
import { getSettings } from './settings'
import { openaiTranscribe } from './modelport/openaiCompat'
import { macDecodeAudio } from './mac/helper'
import { audioExtension } from './audioFormat'
import { extractTarBz2 } from './archive'
import { MACOS } from './platform'
import { capabilities } from './capabilities'

const execFileP = promisify(execFile)

/**
 * Transcription with two backends:
 *  - 'local': NVIDIA Parakeet TDT 0.6B v3 (int8) via sherpa-onnx. Fully offline;
 *    ~25x faster than realtime on CPU. Model is fetched on first use (~490MB).
 *  - 'openai': gpt-4o-mini-transcribe (cloud fallback / no model download).
 *
 * Dictation hands over 16 kHz mono PCM captured in the renderer (see
 * lib/pcmCapture.ts), so the hot path never writes or decodes a file. Only the
 * compressed recording is stored, and only when keepAudio is on.
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
      console.log('[transcribe] downloading Parakeet model (~490MB, one time)…')
      const res = await fetch(MODEL_URL)
      if (!res.ok || !res.body) throw new Error(`download HTTP ${res.status}`)
      await extractTarBz2(Readable.fromWeb(res.body as never), root)
      console.log('[transcribe] Parakeet model ready')
      return localModelReady()
    } catch (err) {
      console.error('[transcribe] local model setup failed:', err)
      return false
    } finally {
      // The archive is never written now (see extractTarBz2), but an install that
      // ran an older build has half a gigabyte of it sitting in userData for a file
      // that was extracted months ago. Clean it up on the way past.
      rmSync(join(modelRoot(), 'parakeet.tar.bz2'), { force: true })
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

/** 16 kHz mono Float32 PCM as a 16-bit WAV — for the cloud upload and for keeping
 *  the words of a take whose transcription failed. */
export function pcmToWav(samples: Float32Array): Buffer {
  const out = Buffer.alloc(44 + samples.length * 2)
  out.write('RIFF', 0)
  out.writeUInt32LE(36 + samples.length * 2, 4)
  out.write('WAVEfmt ', 8)
  out.writeUInt32LE(16, 16)
  out.writeUInt16LE(1, 20) // PCM
  out.writeUInt16LE(1, 22) // mono
  out.writeUInt32LE(16000, 24)
  out.writeUInt32LE(32000, 28)
  out.writeUInt16LE(2, 32)
  out.writeUInt16LE(16, 34)
  out.write('data', 36)
  out.writeUInt32LE(samples.length * 2, 40)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    out.writeInt16LE(Math.round(s * 32767), 44 + i * 2)
  }
  return out
}

/**
 * Decode a stored recording to 16k mono samples — only the retry and scratchpad
 * paths need this; live dictation sends PCM straight from the recorder.
 *
 * Linux pipes ffmpeg's raw f32 output into memory, so no `.16k.wav` copy is ever
 * written next to the recording (those used to double the audio folder). macOS
 * decodes through the Swift helper's AVFoundation path into a temporary WAV that is
 * removed straight after; AVFoundation cannot read WebM, so ffmpeg is still tried
 * there for an old WebM recording.
 */
async function decodeToPcm(path: string): Promise<{ samples?: Float32Array; wavPath?: string }> {
  if (MACOS) {
    const wav = join(app.getPath('temp'), `clipmd-${Date.now()}.16k.wav`)
    try {
      await macDecodeAudio(path, wav)
      return { wavPath: wav }
    } catch (err) {
      rmSync(wav, { force: true })
      console.error('[transcribe] AVFoundation decode failed, trying ffmpeg:', err)
      if (!(await ffmpegAvailable())) {
        throw new Error(
          `could not decode ${path.split('.').pop()} audio: ${err instanceof Error ? err.message : String(err)}`
        )
      }
    }
  }
  const { stdout } = await execFileP(
    'ffmpeg',
    ['-loglevel', 'error', '-i', path, '-ar', '16000', '-ac', '1', '-f', 'f32le', 'pipe:1'],
    { encoding: 'buffer', maxBuffer: 1024 * 1024 * 1024 }
  )
  const buf = stdout as Buffer
  const samples = new Float32Array(buf.byteLength >> 2)
  Buffer.from(samples.buffer).set(buf.subarray(0, samples.length * 4))
  return { samples }
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
 * Inference runs in a utilityProcess: it's a synchronous native call plus a ~640MB
 * model load, which would freeze every window if it ran on the main thread.
 *
 * The worker stays resident between dictations and is only released after
 * ASR_IDLE_MS without use. Loading the model costs ~1.15 s and transcribing a
 * typical take ~0.2 s, so unloading it 30 s after every job (as this used to) made
 * nearly every dictation pay the load. The dictation key's DOWN edge also warms it
 * (warmAsr), so even a cold load overlaps the speaking instead of following it.
 */
const ASR_IDLE_MS = 30 * 60_000
let asrWorker: UtilityProcess | null = null
let asrLoaded = false
let asrIdleTimer: ReturnType<typeof setTimeout> | null = null
let asrSeq = 0
const asrPending = new Map<
  number,
  { resolve: (r: { text: string; ms: number }) => void; reject: (e: Error) => void }
>()

/** Restart the idle countdown; any use (warm-up or job) keeps the model resident. */
function touchAsr(): void {
  if (asrIdleTimer) clearTimeout(asrIdleTimer)
  asrIdleTimer = setTimeout(() => {
    asrIdleTimer = null
    if (asrPending.size === 0 && asrWorker) {
      console.log('[transcribe] releasing the speech model after 30 min idle')
      asrWorker.kill()
    } else {
      touchAsr()
    }
  }, ASR_IDLE_MS)
}

function ensureAsrWorker(): UtilityProcess {
  if (asrWorker) return asrWorker
  const worker = utilityProcess.fork(join(__dirname, 'asrWorker.mjs'), [], {
    serviceName: 'clipmd-asr'
  })
  asrWorker = worker
  asrLoaded = false
  worker.on(
    'message',
    (m: { type: string; id?: number; text?: string; error?: string; ms?: number }) => {
      if (m.type === 'loaded') {
        asrLoaded = true
        console.log(`[transcribe] speech model loaded in ${m.ms}ms`)
        return
      }
      if (m.type === 'loadError') {
        console.error('[transcribe] speech model load failed:', m.error)
        return
      }
      const p = m.id !== undefined ? asrPending.get(m.id) : undefined
      if (!p) return
      asrPending.delete(m.id!)
      if (m.type === 'text') {
        asrLoaded = true
        p.resolve({ text: (m.text ?? '').trim(), ms: m.ms ?? 0 })
      } else p.reject(new Error(m.error ?? 'transcription failed'))
    }
  )
  worker.on('exit', () => {
    // A newer worker may already have replaced this one; only clear our own slot.
    if (asrWorker === worker) {
      asrWorker = null
      asrLoaded = false
    }
    for (const [, p] of asrPending) p.reject(new Error('transcription worker exited'))
    asrPending.clear()
  })
  touchAsr()
  return worker
}

/**
 * Start the worker and load the model now, if local transcription is configured.
 * Called on the dictation key's press, so a cold load runs while the user speaks.
 * Messages are handled in order, so a transcribe sent later simply queues behind
 * the load.
 */
export function warmAsr(): void {
  if (getSettings().transcription.provider !== 'local' || !localModelReady()) return
  if (asrWorker && asrLoaded) {
    touchAsr()
    return
  }
  const fresh = !asrWorker
  const worker = ensureAsrWorker()
  touchAsr()
  if (fresh) worker.postMessage({ type: 'load', modelDir: modelDir() })
}

/** True when the model is resident, i.e. the next transcription is warm. */
export function asrWarm(): boolean {
  return asrWorker !== null && asrLoaded
}

/** Kill the worker (app quit). */
export function stopAsrWorker(): void {
  if (asrIdleTimer) clearTimeout(asrIdleTimer)
  asrIdleTimer = null
  asrWorker?.kill()
  asrWorker = null
  asrLoaded = false
}

async function runLocal(input: { samples?: Float32Array; wavPath?: string }): Promise<{ text: string; ms: number }> {
  if (!(await ensureLocalModel())) throw new Error('local model unavailable')
  const worker = ensureAsrWorker()
  touchAsr()
  const id = ++asrSeq
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      asrPending.delete(id)
      reject(new Error('transcription timed out'))
    }, 120_000)
    asrPending.set(id, {
      resolve: (r) => {
        clearTimeout(timer)
        touchAsr()
        resolve(r)
      },
      reject: (e) => {
        clearTimeout(timer)
        reject(e)
      }
    })
    worker.postMessage({ type: 'transcribe', id, modelDir: modelDir(), ...input })
  })
}

function checkLocalSupported(): void {
  // Refuse loudly rather than fail three steps in. Without ffmpeg the decode
  // throws ENOENT from deep inside the pipeline, which surfaces as "local model
  // setup failed" — a message that sends the user off to re-download 490MB of
  // model that was never the problem.
  const local = capabilities().localTranscribe
  if (local.state === 'unsupported') throw new Error(local.reason)
}

/**
 * Transcribe 16 kHz mono PCM from the dictation recorder. No file, no ffmpeg.
 * `warm` reports whether the model was already resident when the job was sent.
 */
export async function transcribePcm(
  samples: Float32Array
): Promise<{ text: string; asrMs: number; warm: boolean }> {
  if (getSettings().transcription.provider === 'local') {
    // No silent local→cloud fallback: choosing local transcription is a privacy
    // decision, and quietly uploading the recording would violate it.
    const warm = asrWarm()
    const r = await runLocal({ samples })
    return { text: r.text, asrMs: r.ms, warm }
  }
  const t0 = Date.now()
  const text = (await openaiTranscribe(pcmToWav(samples), 'audio/wav')).trim()
  return { text, asrMs: Date.now() - t0, warm: true }
}

/** Transcribe a saved recording using the configured backend. */
export async function transcribeFile(path: string, audio?: Buffer, mime?: string): Promise<string> {
  if (getSettings().transcription.provider === 'local') {
    checkLocalSupported()
    const decoded = await decodeToPcm(path)
    try {
      return (await runLocal(decoded)).text
    } finally {
      if (decoded.wavPath) rmSync(decoded.wavPath, { force: true })
    }
  }
  const buf = audio ?? readFileSync(path)
  return (await openaiTranscribe(buf, mime ?? 'audio/webm')).trim()
}

// ── audio housekeeping ───────────────────────────────────────────────────────

/** Recordings are only kept briefly, for a manual retry; the transcript is the record. */
export const AUDIO_MAX_AGE_MS = 2 * 86_400_000

/**
 * Prune the audio folder. Runs shortly after startup and then hourly.
 * Deletes every recording older than AUDIO_MAX_AGE_MS, whether or not a clip still
 * points at it, plus any `.16k.wav` duplicates older builds wrote.
 */
export function sweepAudio(): void {
  let dir: string
  try {
    dir = audioDir()
  } catch {
    return
  }
  const now = Date.now()
  let removed = 0
  let bytes = 0
  for (const name of readdirSync(dir)) {
    const file = join(dir, name)
    try {
      const st = statSync(file)
      if (!st.isFile()) continue
      if (name.endsWith('.16k.wav') || now - st.mtimeMs > AUDIO_MAX_AGE_MS) {
        rmSync(file, { force: true })
        removed++
        bytes += st.size
      }
    } catch {
      /* raced with another delete */
    }
  }
  if (removed > 0) {
    console.log(`[transcribe] audio sweep removed ${removed} file(s), ${Math.round(bytes / 1e6)} MB`)
  }
}
