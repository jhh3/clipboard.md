import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke, on } from '../lib/ipc'
import { IS_MAC } from '../lib/keys'
import { blobToB64, preferredAudioMime } from '../lib/audio'
import { MicCapture } from '../lib/pcmCapture'
import { useKeymap } from '../hooks/useKeymap'
import { useTheme } from '../hooks/useTheme'

/** Bars in the input-level meter. */
const BAR_COUNT = 24
/** How long the transcript is shown before the HUD reports done. */
const DONE_MS = 1200
/** Errors linger longer — they name the file the recording was kept in. */
const ERROR_MS = 4000
/** Frequency bins fed to the meter: roughly the voice band (see MicCapture). */
const METER_BINS = 24
/** Takes shorter than this are a mis-press, not speech: dropped, never transcribed. */
const MIN_TAKE_SAMPLES = 16000 * 0.3
/** The mic stays open this long after a take, so back-to-back takes start instantly. */
const MIC_IDLE_MS = 5 * 60_000

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
 * `dictation:start` / `dictation:stop` events, each tagged with a take id. Idle
 * renders nothing at all so the window (created hidden at startup and kept alive)
 * can never flash chrome.
 *
 * Audio leaves as 16 kHz PCM (see lib/pcmCapture.ts); a compressed MediaRecorder
 * copy runs alongside only when keepAudio is on, and never delays the transcript.
 */
export default function DictationHud() {
  const theme = useTheme()
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [elapsed, setElapsed] = useState(0)

  const micRef = useRef<MicCapture | null>(null)
  const micIdleRef = useRef(0)
  /** Settings this window needs, kept current by settings:changed — reading them
   *  over IPC used to be one of three slow steps before recording began. */
  const settingsRef = useRef<{ deviceId: string; keepAudio: boolean } | null>(null)

  /** The take main most recently started; events for any other take are stale. */
  const takeRef = useRef(0)
  /** The current take has begun capturing audio. */
  const capturingRef = useRef(false)
  /** A stop arrived while the take was still starting: honour it once it has. */
  const pendingStopRef = useRef(false)
  /** Esc: drop the take instead of transcribing it. */
  const cancelRef = useRef(false)
  const recRef = useRef<MediaRecorder | null>(null)
  /** Start event to first captured audio, for main's timing line. */
  const micMsRef = useRef(0)

  const barsRef = useRef<Array<HTMLSpanElement | null>>([])
  const levelsRef = useRef<Float32Array>(new Float32Array(BAR_COUNT))
  const rafRef = useRef(0)
  const timerRef = useRef(0)

  // ── microphone ────────────────────────────────────────────────────────────

  const releaseMic = useCallback(() => {
    window.clearTimeout(micIdleRef.current)
    micRef.current?.close()
    micRef.current = null
  }, [])

  /** Keep the mic warm between takes, and let it go once dictation goes quiet. */
  const scheduleMicIdle = useCallback(() => {
    window.clearTimeout(micIdleRef.current)
    micIdleRef.current = window.setTimeout(() => {
      if (!capturingRef.current) releaseMic()
    }, MIC_IDLE_MS)
  }, [releaseMic])

  const loadSettings = useCallback(async () => {
    if (settingsRef.current) return settingsRef.current
    try {
      const s = await invoke('settings:get')
      settingsRef.current = { deviceId: s.dictation.deviceId?.trim() ?? '', keepAudio: s.dictation.keepAudio }
    } catch {
      settingsRef.current = { deviceId: '', keepAudio: false }
    }
    return settingsRef.current
  }, [])

  /** The open mic for the configured device, reopening only when that changed. */
  const acquireMic = useCallback(async (): Promise<MicCapture> => {
    const { deviceId } = await loadSettings()
    const mic = micRef.current
    if (mic && mic.live && mic.deviceId === deviceId && !mic.fellBack) return mic
    releaseMic()
    const opened = await MicCapture.open(deviceId)
    micRef.current = opened
    return opened
  }, [loadSettings, releaseMic])

  // ── finishing ─────────────────────────────────────────────────────────────

  /** Tell main this take is over; it hides the window unless a newer take began. */
  const finish = useCallback(
    (take: number, reason?: string) => {
      if (take !== takeRef.current) return
      window.clearTimeout(timerRef.current)
      setPhase({ kind: 'idle' })
      setElapsed(0)
      scheduleMicIdle()
      void invoke('dictation:done', take, reason).catch(() => {})
    },
    [scheduleMicIdle]
  )

  const finishAfter = useCallback(
    (take: number, ms: number) => {
      if (take !== takeRef.current) return
      window.clearTimeout(timerRef.current)
      timerRef.current = window.setTimeout(() => finish(take), ms)
    },
    [finish]
  )

  // ── start / stop ──────────────────────────────────────────────────────────

  const stop = useCallback(
    async (take: number) => {
      if (take !== takeRef.current) return
      if (!capturingRef.current) {
        // Still starting (mic opening): remembered, and acted on the moment it has.
        pendingStopRef.current = true
        return
      }
      capturingRef.current = false
      const mic = micRef.current
      const rec = recRef.current
      recRef.current = null
      const pcm = mic ? await mic.stop() : new Float32Array(0)
      const cancelled = cancelRef.current
      if (cancelled || pcm.length < MIN_TAKE_SAMPLES) {
        if (rec && rec.state !== 'inactive') {
          rec.ondataavailable = null
          rec.stop()
        }
        finish(take, cancelled ? 'cancelled' : `dropped: only ${Math.round(pcm.length / 16)}ms of audio`)
        return
      }
      // The compressed copy goes on its own channel; transcription doesn't wait for it.
      if (rec && rec.state !== 'inactive') {
        const parts: Blob[] = []
        rec.ondataavailable = (e) => {
          if (e.data.size > 0) parts.push(e.data)
        }
        rec.onstop = () => {
          const blob = new Blob(parts, { type: rec.mimeType })
          void blobToB64(blob)
            .then((audioB64) => invoke('dictation:audio', { take, audioB64, mime: rec.mimeType }))
            .catch(() => {})
        }
        rec.stop()
      }
      if (take === takeRef.current) setPhase({ kind: 'transcribing' })
      try {
        const res = await invoke('dictation:transcribe', {
          take,
          pcm,
          micMs: micMsRef.current,
          withAudio: rec !== null
        })
        if (take !== takeRef.current) return
        if (res.ok && res.text) {
          setPhase({ kind: 'done', text: res.text, pasted: res.pasted === true })
          finishAfter(take, DONE_MS)
        } else {
          setPhase({ kind: 'error', message: res.error ?? 'Transcription failed' })
          finishAfter(take, ERROR_MS)
        }
      } catch {
        if (take !== takeRef.current) return
        setPhase({ kind: 'error', message: 'Transcription failed' })
        finishAfter(take, ERROR_MS)
      }
    },
    [finish, finishAfter]
  )

  const start = useCallback(
    async (take: number) => {
      const t0 = performance.now()
      takeRef.current = take
      capturingRef.current = false
      pendingStopRef.current = false
      cancelRef.current = false
      micMsRef.current = 0
      window.clearTimeout(timerRef.current)
      window.clearTimeout(micIdleRef.current)
      // A previous take's recorder still flushing belongs to that take; drop ours.
      recRef.current = null
      try {
        const mic = await acquireMic()
        if (take !== takeRef.current) return
        void mic.start().then(() => {
          if (take === takeRef.current) micMsRef.current = Math.round(performance.now() - t0)
        })
        capturingRef.current = true
        if (settingsRef.current?.keepAudio) {
          try {
            const rec = new MediaRecorder(mic.stream, { mimeType: preferredAudioMime() })
            // No timeslice: one complete, self-contained file at stop.
            rec.start()
            recRef.current = rec
          } catch {
            /* the PCM path is what matters; the stored copy is best effort */
          }
        }
        setElapsed(0)
        setPhase({ kind: 'recording', fellBack: mic.fellBack })
        if (pendingStopRef.current) void stop(take)
      } catch {
        releaseMic()
        if (take !== takeRef.current) return
        setPhase({
          kind: 'error',
          message: 'Microphone unavailable',
          note: 'Grant microphone access, then try again'
        })
        finishAfter(take, ERROR_MS)
      }
    },
    [acquireMic, finishAfter, releaseMic, stop]
  )

  useEffect(() => {
    const offStart = on('dictation:start', ({ take }) => void start(take))
    const offStop = on('dictation:stop', ({ take }) => void stop(take))
    const offSettings = on('settings:changed', ({ settings }) => {
      settingsRef.current = {
        deviceId: settings.dictation.deviceId?.trim() ?? '',
        keepAudio: settings.dictation.keepAudio
      }
    })
    // Subscribed: main can now send anything it queued while this window loaded.
    void invoke('dictation:ready').catch(() => {})
    void loadSettings()
    return () => {
      offStart()
      offStop()
      offSettings()
    }
  }, [start, stop, loadSettings])

  /** Esc cancels: an active take is dropped, a finished one is dismissed. */
  useKeymap((e) => {
    if (e.key !== 'Escape') return
    e.preventDefault()
    const take = takeRef.current
    cancelRef.current = true
    if (capturingRef.current) {
      void stop(take)
    } else {
      // Starting (the take then stops and drops itself) or showing a result.
      pendingStopRef.current = true
      finish(take, 'dismissed')
    }
  })

  useEffect(
    () => () => {
      window.clearTimeout(timerRef.current)
      cancelAnimationFrame(rafRef.current)
      releaseMic()
    },
    [releaseMic]
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
      const analyser = micRef.current?.analyser
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
            ) : (
              <>
                Release <kbd>{IS_MAC ? '🌐' : '⌃⌥Space'}</kbd> to finish
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
            <span className="hud-footnote">
              {phase.pasted ? 'Pasted' : 'Copied to clipboard'}
            </span>
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
