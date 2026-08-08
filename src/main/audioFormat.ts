/**
 * One mime → container mapping, used by everything that names a recording.
 *
 * This existed twice — once in transcribe.saveRecording, once in the OpenAI upload —
 * and the copies drifted the moment darwin started recording mp4: the upload still
 * mapped anything unrecognised to "wav", so an AAC/mp4 recording was sent as
 * `audio.wav` and the API rejected it ("This model does not support the format you
 * provided"), because it identifies the container by file extension.
 *
 * Both callers now agree by construction.
 */
export function audioExtension(mime: string): string {
  const m = mime.toLowerCase()
  if (m.includes('webm')) return 'webm'
  if (m.includes('ogg') || m.includes('opus')) return 'ogg'
  if (m.includes('mp4') || m.includes('m4a') || m.includes('aac')) return 'm4a'
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3'
  if (m.includes('flac')) return 'flac'
  return 'wav'
}

/**
 * The mime type without codec parameters — `audio/mp4;codecs=mp4a.40.2` becomes
 * `audio/mp4`. MediaRecorder hands back the full string, but it belongs in a
 * Content-Type header about as much as a charset belongs in a filename.
 */
export function baseMime(mime: string): string {
  return mime.split(';')[0].trim()
}
