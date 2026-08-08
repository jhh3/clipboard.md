/**
 * Audio helpers shared by the scratchpad mic and the dictation HUD.
 */
import { invoke } from './ipc'

/** Read a Blob as bare base64 (no `data:` prefix) — the wire format for `scratch:transcribe`. */
export function blobToB64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onerror = () => reject(r.error)
    r.onload = () => {
      const s = String(r.result)
      resolve(s.slice(s.indexOf(',') + 1))
    }
    r.readAsDataURL(blob)
  })
}

/**
 * The container to record in, per platform.
 *
 * Local transcription needs the recording decoded to raw 16k mono samples. Linux does
 * that with ffmpeg; macOS does not ship ffmpeg, so it decodes with AVFoundation via
 * the Swift helper — and AVFoundation cannot read WebM or Opus at all (verified: an
 * Opus-in-WebM file reports "no audio track"). mp4/AAC is the format both Chromium
 * can record and AVFoundation can read, so darwin asks for that first.
 *
 * The WebM fallbacks stay: if a Chromium build can't record mp4, a recording that
 * needs Homebrew ffmpeg to transcribe still beats no recording at all.
 */
export function preferredAudioMime(): string {
  const candidates =
    navigator.platform.toLowerCase().includes('mac') || navigator.userAgent.includes('Mac OS X')
      ? ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm;codecs=opus', 'audio/webm']
      : ['audio/webm;codecs=opus', 'audio/webm']
  return candidates.find((m) => MediaRecorder.isTypeSupported(m)) ?? 'audio/webm'
}

// ── microphone selection ─────────────────────────────────────────────────────

export interface MicStreamResult {
  stream: MediaStream
  /** True when the configured mic was gone and the system default was used instead. */
  fellBack: boolean
}

/**
 * The mic configured in Settings, re-read from main on every call.
 *
 * Deliberately not memoised: each recording session asks again so changing the
 * device in Settings takes effect without restarting the app.
 */
export async function configuredMicDeviceId(): Promise<string> {
  try {
    const s = await invoke('settings:get')
    return s.dictation.deviceId?.trim() ?? ''
  } catch {
    return ''
  }
}

/** getUserMedia rejections that mean "that device isn't there any more". */
function isDeviceGone(err: unknown): boolean {
  const name = (err as { name?: string } | null | undefined)?.name
  return name === 'OverconstrainedError' || name === 'NotFoundError'
}

/**
 * Open the mic, honouring the configured device.
 *
 * If the saved device has been unplugged we retry once on the system default
 * rather than failing the recording — losing the audio is far worse than
 * recording it on the wrong mic.
 */
export async function openMicStream(deviceId: string): Promise<MicStreamResult> {
  if (deviceId) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: deviceId } }
      })
      return { stream, fellBack: false }
    } catch (err) {
      if (!isDeviceGone(err)) throw err
    }
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  return { stream, fellBack: deviceId !== '' }
}
