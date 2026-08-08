import { describe, it, expect } from 'vitest'
import { audioExtension, baseMime } from './audioFormat'

describe('audioExtension', () => {
  it('maps what MediaRecorder actually produces on each platform', () => {
    // darwin records mp4/AAC (AVFoundation cannot decode WebM/Opus); linux records webm.
    expect(audioExtension('audio/mp4;codecs=mp4a.40.2')).toBe('m4a')
    expect(audioExtension('audio/webm;codecs=opus')).toBe('webm')
  })

  it('does not fall back to wav for a container it knows', () => {
    // The regression: mp4 fell through to 'wav', so the upload was named audio.wav
    // and OpenAI rejected it — the API identifies the container by file extension.
    for (const mime of ['audio/mp4', 'audio/m4a', 'audio/aac']) {
      expect(audioExtension(mime)).not.toBe('wav')
    }
  })

  it('is case-insensitive', () => {
    expect(audioExtension('AUDIO/MP4;CODECS=MP4A.40.2')).toBe('m4a')
  })

  it('falls back to wav only for genuinely unknown types', () => {
    expect(audioExtension('audio/x-something-new')).toBe('wav')
  })
})

describe('baseMime', () => {
  it('strips codec parameters', () => {
    expect(baseMime('audio/mp4;codecs=mp4a.40.2')).toBe('audio/mp4')
    expect(baseMime('audio/webm; codecs=opus')).toBe('audio/webm')
  })

  it('leaves a bare type alone', () => {
    expect(baseMime('audio/wav')).toBe('audio/wav')
  })
})
