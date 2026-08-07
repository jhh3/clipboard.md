/**
 * Audio helpers shared by the scratchpad mic and the dictation HUD.
 */

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

/** The best opus container this Chromium build will record, for MediaRecorder. */
export function preferredAudioMime(): string {
  return MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus'
    : 'audio/webm'
}
