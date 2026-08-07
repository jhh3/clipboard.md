import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke, on } from '../lib/ipc'
import { blobToB64, configuredMicDeviceId, openMicStream, preferredAudioMime } from '../lib/audio'
import { useKeymap } from '../hooks/useKeymap'
import { useTheme } from '../hooks/useTheme'
import { useToasts } from '../hooks/useToasts'
import DragStrip from './DragStrip'
import Toasts from './Toasts'
import { MicIcon } from './icons'

function formatElapsed(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

/** "Speak/edit into your clipboard" window (#scratchpad route). */
export default function Scratchpad() {
  const [text, setText] = useState('')
  const [itemId, setItemId] = useState<number | undefined>(undefined)
  const [mono, setMono] = useState(false)
  const [recording, setRecording] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const { toasts, addToast } = useToasts()
  const theme = useTheme()

  const taRef = useRef<HTMLTextAreaElement | null>(null)
  const recRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])

  // ── load item on show ─────────────────────────────────────────────────────
  useEffect(() => {
    const off = on('scratchpad:shown', (p) => {
      if (p.itemId != null) {
        invoke('item:get', p.itemId)
          .then((item) => {
            if (item && !item.secret && item.kind !== 'image' && item.kind !== 'files') {
              setText(item.content)
              setItemId(item.id)
            }
          })
          .catch(() => {})
      } else {
        // Fresh open: keep any unsaved draft, but stop deriving from an old clip.
        setItemId(undefined)
      }
      window.setTimeout(() => taRef.current?.focus(), 0)
    })
    return off
  }, [])

  // ── text insertion at the caret (for transcription results) ─────────────
  const insertAtCursor = useCallback((snippet: string) => {
    const ta = taRef.current
    setText((prev) => {
      const start = ta ? ta.selectionStart : prev.length
      const end = ta ? ta.selectionEnd : prev.length
      const pad = start > 0 && !/\s$/.test(prev.slice(0, start)) ? ' ' : ''
      const next = prev.slice(0, start) + pad + snippet + prev.slice(end)
      const caret = start + pad.length + snippet.length
      requestAnimationFrame(() => {
        if (ta) {
          ta.focus()
          ta.setSelectionRange(caret, caret)
        }
      })
      return next
    })
  }, [])

  // ── recording / transcription ─────────────────────────────────────────────
  const finishRecording = useCallback(async () => {
    const rec = recRef.current
    recRef.current = null
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    setRecording(false)
    const mime = rec?.mimeType || 'audio/webm'
    const blob = new Blob(chunksRef.current, { type: mime })
    chunksRef.current = []
    if (blob.size === 0) return
    setTranscribing(true)
    try {
      const audioB64 = await blobToB64(blob)
      const res = await invoke('scratch:transcribe', { audioB64, mime })
      if (res.ok && res.text) insertAtCursor(res.text)
      else addToast(res.error ?? 'Transcription failed', 'error')
    } catch {
      addToast('Transcription failed', 'error')
    } finally {
      setTranscribing(false)
    }
  }, [addToast, insertAtCursor])

  // The recorder's onstop must always call the latest closure.
  const finishRef = useRef(finishRecording)
  finishRef.current = finishRecording

  const startRecording = useCallback(async () => {
    if (recRef.current || transcribing) return
    try {
      // Re-read the configured mic per session so a change in Settings applies
      // without restarting. The stream is closed on stop, so there is nothing
      // stale to invalidate here.
      const { stream, fellBack } = await openMicStream(await configuredMicDeviceId())
      streamRef.current = stream
      if (fellBack) addToast('Chosen mic unavailable — using the system default', 'info')
      const mime = preferredAudioMime()
      const rec = new MediaRecorder(stream, { mimeType: mime })
      chunksRef.current = []
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data)
      }
      rec.onstop = () => void finishRef.current()
      rec.start(250)
      recRef.current = rec
      setElapsed(0)
      setRecording(true)
    } catch {
      addToast('Microphone unavailable — check permissions', 'error')
    }
  }, [addToast, transcribing])

  const stopRecording = useCallback(() => {
    recRef.current?.stop()
  }, [])

  const toggleRecording = useCallback(() => {
    if (recRef.current) stopRecording()
    else void startRecording()
  }, [startRecording, stopRecording])

  useEffect(() => {
    if (!recording) return
    const started = Date.now()
    const t = window.setInterval(
      () => setElapsed(Math.floor((Date.now() - started) / 1000)),
      250
    )
    return () => window.clearInterval(t)
  }, [recording])

  // ── save / copy / paste ───────────────────────────────────────────────────
  const save = useCallback(async (): Promise<number | null> => {
    if (!text.trim()) {
      addToast('Nothing to save', 'info')
      return null
    }
    try {
      const id = await invoke('scratch:save', { text, itemId })
      setItemId(id)
      return id
    } catch {
      addToast('Save failed', 'error')
      return null
    }
  }, [text, itemId, addToast])

  const onSave = useCallback(async () => {
    if ((await save()) != null) addToast('Saved to history', 'success')
  }, [save, addToast])

  const onCopy = useCallback(async () => {
    const id = await save()
    if (id == null) return
    try {
      await invoke('item:copy', id)
      addToast('Copied to clipboard', 'success')
    } catch {
      addToast('Copy failed', 'error')
    }
  }, [save, addToast])

  const onPaste = useCallback(async () => {
    const id = await save()
    if (id == null) return
    try {
      const outcome = await invoke('item:paste', id, {})
      if (outcome.method === 'injected') {
        void invoke('window:hide')
      } else {
        addToast(outcome.message ?? 'Copied — press Ctrl+V to paste', 'info')
        window.setTimeout(() => void invoke('window:hide'), 900)
      }
    } catch {
      addToast('Paste failed', 'error')
    }
  }, [save, addToast])

  // ── keys: Ctrl+S save, Ctrl+Space record toggle, Esc hide ────────────────
  useKeymap((e) => {
    const mod = e.ctrlKey || e.metaKey
    if (e.key === 'Escape') {
      e.preventDefault()
      if (recRef.current) stopRecording()
      void invoke('window:hide')
      return
    }
    if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault()
      void onSave()
      return
    }
    if (mod && e.code === 'Space') {
      e.preventDefault()
      toggleRecording()
    }
  })

  const trimmed = text.trim()
  const words = trimmed ? trimmed.split(/\s+/).length : 0

  return (
    <div className="appwin scratch-win" data-theme={theme}>
      <DragStrip
        title={
          <>
            Scratchpad
            {itemId != null && <span className="scratch-item-badge">clip #{itemId}</span>}
          </>
        }
        tools={
          <label className="mono-toggle">
            <input type="checkbox" checked={mono} onChange={(e) => setMono(e.target.checked)} />
            monospace
          </label>
        }
      />
      <div className="scratch-body">
        <textarea
          ref={taRef}
          className={'scratch-text' + (mono ? ' mono' : '')}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Type, or press the mic and speak…"
          autoFocus
        />
        <div className="scratch-mic-row">
          <button
            className={'mic-btn' + (recording ? ' recording' : '')}
            onClick={toggleRecording}
            disabled={transcribing}
            title="Record voice (Ctrl+Space)"
          >
            <MicIcon size={15} />
            {recording ? (
              <>
                <span className="rec-dot" />
                <span className="rec-elapsed">{formatElapsed(elapsed)}</span>
              </>
            ) : transcribing ? (
              'Transcribing…'
            ) : (
              'Record'
            )}
          </button>
          {recording && (
            <span className="rec-hint">Recording — click again or Ctrl+Space to stop</span>
          )}
          {transcribing && <span className="spinner" aria-label="Transcribing…" />}
        </div>
      </div>
      <footer className="scratch-footer">
        <div className="scratch-actions">
          <button className="btn primary" onClick={() => void onSave()} title="Ctrl+S">
            Save to history
          </button>
          <button className="btn" onClick={() => void onCopy()}>
            Copy
          </button>
          <button className="btn" onClick={() => void onPaste()}>
            Paste
          </button>
        </div>
        <div className="scratch-counts">
          {words.toLocaleString()} words · {text.length.toLocaleString()} chars
        </div>
      </footer>
      <Toasts toasts={toasts} />
    </div>
  )
}
