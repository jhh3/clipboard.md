import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke, on } from '../lib/ipc'
import { blobToB64, configuredMicDeviceId, openMicStream, preferredAudioMime } from '../lib/audio'
import { useKeymap } from '../hooks/useKeymap'
import { useTheme } from '../hooks/useTheme'

/** Bars in the input-level meter. */
const BAR_COUNT = 24
/** How long the transcript is shown before the HUD reports done. */
const DONE_MS = 1200
/** Errors linger longer — they name the file the recording was kept in. */
const ERROR_MS = 4000
/** Frequency bins fed to the meter: ~0–4.5 kHz at fftSize 256, i.e. the voice band. */
const METER_BINS = 24

type Phase =
  | { kind: 'idle' }
  /** `fellBack`: the configured mic was gone, so this is the system default. */
  | { kind: 'recording'; fellBack: boolean }
  | { kind: 'transcribing' }
  | { kind: 'done'; text: string; pasted: boolean }
  | { kind: 'error'; message: string; note?: string }

function formatElapsed(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * Dictation overlay (#dictation route).
 *
 * The window is frameless, transparent and `focusable: false`, so this surface
 * never receives keyboard input — every transition is driven by main via the
 * `dictation:start` / `dictation:stop` events. Idle renders nothing at all so
 * the window (which is kept alive hidden between uses) can never flash chrome.
 */
export default function DictationHud() {
  const theme = useTheme()
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [elapsed, setElapsed] = useState(0)

  // Long-lived audio graph: the stream and its analyser are requested once and
  // reused for every dictation session (permission + warm-up paid one time).
  const streamRef = useRef<MediaStream | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  /** The configured deviceId the cached stream was opened for ('' = default). */
  const streamDeviceRef = useRef('')
  /** The cached stream is a fallback: retry the real device next session. */
  const streamFellBackRef = useRef(false)

  const recRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])

  const barsRef = useRef<Array<HTMLSpanElement | null>>([])
  const levelsRef = useRef<Float32Array>(new Float32Array(BAR_COUNT))
  const rafRef = useRef(0)
  const timerRef = useRef(0)
  /** When this recording began — distinguishes a tap (latch) from a hold (PTT). */
  const startedAtRef = useRef(0)
  const latchedRef = useRef(false)
  const [latched, setLatched] = useState(false)

  // ── finishing ─────────────────────────────────────────────────────────────

  /** Tell main the flow is over; it hides the window and resets its own state. */
  const finish = useCallback(() => {
    window.clearTimeout(timerRef.current)
    setPhase({ kind: 'idle' })
    setElapsed(0)
    void invoke('dictation:done').catch(() => {})
  }, [])

  const finishAfter = useCallback(
    (ms: number) => {
      window.clearTimeout(timerRef.current)
      timerRef.current = window.setTimeout(finish, ms)
    },
    [finish]
  )

  // ── microphone ────────────────────────────────────────────────────────────

  /**
   * The shared stream, requesting (and re-wiring the analyser) only when needed.
   *
   * The cache is keyed on the configured deviceId, so picking a different mic in
   * Settings takes effect on the next dictation without an app restart. A stream
   * that fell back to the default is never reused either — that way a mic that
   * gets plugged back in is picked up again.
   */
  const acquireStream = useCallback(async (): Promise<{
    stream: MediaStream
    fellBack: boolean
  }> => {
    const wanted = await configuredMicDeviceId()
    const existing = streamRef.current
    const live = existing?.getAudioTracks().some((t) => t.readyState === 'live') ?? false
    if (existing && live && streamDeviceRef.current === wanted && !streamFellBackRef.current) {
      return { stream: existing, fellBack: false }
    }

    // Release the previous mic first — otherwise the old device stays hot
    // (recording indicator on) after a device switch.
    existing?.getTracks().forEach((t) => t.stop())
    streamRef.current = null

    const opened = await openMicStream(wanted)
    streamRef.current = opened.stream
    streamDeviceRef.current = wanted
    streamFellBackRef.current = opened.fellBack

    void audioCtxRef.current?.close().catch(() => {})
    const ctx = new AudioContext()
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 256
    analyser.smoothingTimeConstant = 0.7
    ctx.createMediaStreamSource(opened.stream).connect(analyser)
    audioCtxRef.current = ctx
    analyserRef.current = analyser
    return { stream: opened.stream, fellBack: opened.fellBack }
  }, [])

  // ── transcription (runs from MediaRecorder.onstop) ────────────────────────

  const deliver = useCallback(async () => {
    const rec = recRef.current
    recRef.current = null
    const mime = rec?.mimeType || preferredAudioMime()
    const blob = new Blob(chunksRef.current, { type: mime })
    chunksRef.current = []
    if (blob.size === 0) {
      finish()
      return
    }
    setPhase({ kind: 'transcribing' })
    try {
      const audioB64 = await blobToB64(blob)
      const res = await invoke('scratch:transcribe', { audioB64, mime, dictation: true })
      if (res.ok && res.text) {
        setPhase({ kind: 'done', text: res.text, pasted: res.pasted === true })
        finishAfter(DONE_MS)
      } else {
        setPhase({
          kind: 'error',
          message: res.error ?? 'Transcription failed',
          note: 'Recording saved — retry from history'
        })
        finishAfter(ERROR_MS)
      }
    } catch {
      setPhase({
        kind: 'error',
        message: 'Transcription failed',
        note: 'Recording saved — retry from history'
      })
      finishAfter(ERROR_MS)
    }
  }, [finish, finishAfter])

  // MediaRecorder.onstop fires long after it was assigned — always call the latest closure.
  const deliverRef = useRef(deliver)
  deliverRef.current = deliver

  // ── start / stop ──────────────────────────────────────────────────────────

  const start = useCallback(async () => {
    if (recRef.current) return
    window.clearTimeout(timerRef.current)
    try {
      const { stream, fellBack } = await acquireStream()
      const mime = preferredAudioMime()
      const rec = new MediaRecorder(stream, { mimeType: mime })
      chunksRef.current = []
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data)
      }
      rec.onstop = () => void deliverRef.current()
      rec.start(250)
      recRef.current = rec
      setElapsed(0)
      setPhase({ kind: 'recording', fellBack })
    } catch {
      setPhase({
        kind: 'error',
        message: 'Microphone unavailable',
        note: 'Grant microphone access, then try again'
      })
      finishAfter(ERROR_MS)
    }
  }, [acquireStream, finishAfter])

  /**
   * Stop only ever ends an in-flight recording. A stray stop (double hotkey
   * while the transcript is already in flight) is ignored — reporting done
   * early would hide the HUD mid-transcription.
   */
  const stop = useCallback(() => {
    const rec = recRef.current
    // The stream itself is deliberately left running — it is reused next time.
    if (rec && rec.state !== 'inactive') rec.stop()
  }, [])

  useEffect(() => {
    const offStart = on('dictation:start', () => {
      startedAtRef.current = Date.now()
      latchedRef.current = false
      void start()
    })
    const offStop = on('dictation:stop', () => stop())
    return () => {
      offStart()
      offStop()
    }
  }, [start, stop])

  /**
   * Push-to-talk. The global hotkey can only report key-DOWN, so the release is
   * observed here: this window takes focus when it appears, and the first key-up
   * of the trigger combo ends the recording.
   *
   * Tapping the hotkey instead of holding it latches recording on, so a quick
   * press still works like a toggle — you don't have to keep a chord held down
   * for a long dictation.
   */
  const LATCH_THRESHOLD_MS = 400
  useEffect(() => {
    const onKeyUp = (e: KeyboardEvent): void => {
      if (!recRef.current || latchedRef.current) return
      const isTrigger = e.key === ' ' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta'
      if (!isTrigger) return
      if (Date.now() - startedAtRef.current < LATCH_THRESHOLD_MS) {
        latchedRef.current = true // tapped, not held — stay recording
        setLatched(true)
        return
      }
      stop()
    }
    window.addEventListener('keyup', onKeyUp)
    return () => window.removeEventListener('keyup', onKeyUp)
  }, [stop])

  useKeymap((e) => {
    if (e.key !== 'Escape') return
    e.preventDefault()
    if (recRef.current) {
      chunksRef.current = [] // discard: Esc cancels rather than transcribes
      stop()
    } else {
      finish()
    }
  })

  useEffect(
    () => () => {
      window.clearTimeout(timerRef.current)
      cancelAnimationFrame(rafRef.current)
    },
    []
  )

  // ── elapsed clock ─────────────────────────────────────────────────────────

  const recording = phase.kind === 'recording'

  useEffect(() => {
    if (!recording) return
    const started = Date.now()
    const t = window.setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 250)
    return () => window.clearInterval(t)
  }, [recording])

  // ── level meter ───────────────────────────────────────────────────────────
  // Bars are written straight to the DOM: a 60fps React render for 24 spans
  // would be the most expensive thing this window ever does.

  useEffect(() => {
    if (!recording || prefersReducedMotion()) return
    const freq = new Uint8Array(METER_BINS)
    const levels = levelsRef.current
    const tick = () => {
      const analyser = analyserRef.current
      if (analyser) {
        analyser.getByteFrequencyData(freq)
        for (let i = 0; i < BAR_COUNT; i++) {
          // Gentle boost so ordinary speech fills the meter, then temporal easing.
          const target = Math.min(1, (freq[i] / 255) * 1.9)
          const next = levels[i] + (target - levels[i]) * 0.4
          levels[i] = next
          const bar = barsRef.current[i]
          if (bar) {
            bar.style.transform = `scaleY(${(0.1 + next * 0.9).toFixed(3)})`
            bar.style.opacity = (0.28 + next * 0.72).toFixed(3)
          }
        }
      }
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafRef.current)
  }, [recording])

  // ── render ────────────────────────────────────────────────────────────────

  if (phase.kind === 'idle') return null

  return (
    <div className="hud" data-theme={theme} data-phase={phase.kind}>
      {phase.kind === 'recording' && (
        <>
          <div className="hud-head">
            <span className="hud-rec-dot" />
            <span className="hud-status">Listening…</span>
            <span className="hud-elapsed">{formatElapsed(elapsed)}</span>
          </div>
          <div className="hud-meter" aria-hidden="true">
            {Array.from({ length: BAR_COUNT }, (_, i) => (
              <span
                key={i}
                className="hud-bar"
                ref={(el) => {
                  barsRef.current[i] = el
                }}
              />
            ))}
          </div>
          <div className="hud-hint">
            {phase.fellBack ? (
              // Not an error: recording is running, just on a different mic.
              <span className="hud-note">Chosen mic unavailable — using the system default</span>
            ) : latched ? (
              <>
                <kbd>⌃⌥Space</kbd> to stop · <kbd>Esc</kbd> cancel
              </>
            ) : (
              <>
                Release <kbd>⌃⌥Space</kbd> to finish · <kbd>Esc</kbd> cancel
              </>
            )}
          </div>
        </>
      )}

      {phase.kind === 'transcribing' && (
        <>
          <div className="hud-head">
            <span className="hud-status">Transcribing…</span>
          </div>
          <div className="hud-shimmer" aria-hidden="true">
            <span />
          </div>
          <div className="hud-hint">Turning your audio into text</div>
        </>
      )}

      {phase.kind === 'done' && (
        <>
          <div className="hud-head">
            <span className="hud-status done">Done</span>
            <span className="hud-footnote">{phase.pasted ? 'Pasted' : 'Copied to clipboard'}</span>
          </div>
          <div className="hud-transcript">{phase.text}</div>
        </>
      )}

      {phase.kind === 'error' && (
        <>
          <div className="hud-head">
            <span className="hud-status error">Couldn’t transcribe</span>
          </div>
          <div className="hud-error">{phase.message}</div>
          {phase.note && <div className="hud-hint">{phase.note}</div>}
        </>
      )}
    </div>
  )
}
