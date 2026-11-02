import { app, ipcMain, nativeImage, BrowserWindow, dialog } from 'electron'
import { existsSync, rmSync, writeFileSync } from 'fs'
import { isTrustedSender } from './security'
import type { SearchQuery, AppSettings } from '@shared/types'
import {
  searchKeyword,
  searchHybrid,
  getItem,
  setPinned,
  deleteItem,
  enrichQueueStats,
  upsertClip,
  updateEnrichment,
  exportAll
} from './store/items'
import { saveRecording, transcribeFile, transcribePcm, pcmToWav } from './transcribe'
import { correctTranscript, styleForApp } from './dictionary'
import {
  notePastedTranscript,
  listSuggestions,
  acceptSuggestion,
  dismissSuggestion
} from './corrections'
import { getDictationTarget } from './focusedWindow'
import { enhanceTranscript } from './enhance'
import { getSettings, updateSettings } from './settings'
import {
  hidePalette,
  getPalette,
  sendToPalette,
  openSettingsWindow,
  markDictationHudReady
} from './windows'
import { startAsk, cancelAsk, rewriteText } from './ask'
import type { PasteService } from './paste'
import type { CaptureService } from './capture'
import { providersStatus } from './modelport'
import { enrichmentRunStats } from './enrichment'
import { embedQuery } from './embeddings'
import { takeScreenshot } from './screenshot'

/**
 * What a dictation does with its transcript. Both record identically:
 *  - 'paste'   deterministic cleanup, then paste into the focused app
 *  - 'enhance' the same, plus an AI pass, then paste
 */
export type DictateMode = 'paste' | 'enhance'

export interface RewriteState {
  getText: () => string | null
  /** Mode and timestamps of a dictation take, by the id main gave it at key-down. */
  takeInfo: (take: number) => { mode: DictateMode; startedAt: number; stoppedAt?: number } | undefined
  /** The HUD finished a take (delivered, dropped or failed). */
  onDictationDone: (take: number, reason?: string) => void
}

/**
 * Wrap ipcMain.handle so every channel validates its sender and can never reject
 * into the renderer with a raw stack. A handler that throws returns a plain error
 * shape instead of an unhandled rejection.
 */
function handle(channel: string, fn: (e: Electron.IpcMainInvokeEvent, ...a: any[]) => unknown): void {
  ipcMain.handle(channel, async (e, ...args) => {
    if (!isTrustedSender(e.sender)) {
      console.error(`[ipc] rejected ${channel} from untrusted sender`)
      throw new Error('untrusted sender')
    }
    try {
      return await fn(e, ...args)
    } catch (err) {
      console.error(`[ipc] ${channel} failed:`, err)
      throw new Error(err instanceof Error ? err.message : String(err))
    }
  })
}

export function registerIpc(
  paste: PasteService,
  capture: CaptureService,
  rewrite: RewriteState
): void {
  handle('dictation:done', (_e, take: number, reason?: string) => rewrite.onDictationDone(take, reason))
  handle('dictation:ready', () => markDictationHudReady())

  handle('search', (_e, q: SearchQuery) => {
    const started = performance.now()
    const res = searchKeyword(q)
    console.log(`[search] keyword ${res.items.length} results in ${(performance.now() - started).toFixed(1)}ms`)
    return res
  })
  handle('search:semantic', async (_e, q: SearchQuery) => {
    if (!q.q.trim()) return searchKeyword(q)
    const started = performance.now()
    const qe = await embedQuery(q.q)
    const embedded = performance.now()
    const res = searchHybrid(q, qe)
    console.log(
      `[search] ${res.mode} ${res.items.length} results in ${(performance.now() - started).toFixed(1)}ms ` +
        `(embed ${(embedded - started).toFixed(1)}ms)`
    )
    return res
  })

  handle('item:get', (_e, id: number) => getItem(id))
  handle('item:pin', (_e, id: number, pinned: boolean) => {
    setPinned(id, pinned)
    sendToPalette('items:changed', { reason: 'transformed' })
  })
  handle('item:delete', (_e, id: number) => {
    deleteItem(id)
    sendToPalette('items:changed', { reason: 'deleted' })
  })
  handle('item:paste', (_e, id: number, opts: { plain?: boolean }) =>
    paste.pasteItem(id, !!opts?.plain)
  )
  handle('item:copy', (_e, id: number) => paste.copyItem(id))
  handle('item:image-data', (_e, id: number) => {
    const item = getItem(id)
    if (!item || item.kind !== 'image') return null
    const img = nativeImage.createFromPath(item.content)
    return img.isEmpty() ? null : img.toDataURL()
  })

  handle('paste:text', (_e, payload: { text: string }) => paste.pasteRaw(payload.text, 'text'))
  handle('ask:start', (e, payload: { text: string; itemId?: number }) =>
    startAsk(payload.text, payload.itemId, (channel, data) => {
      if (!e.sender.isDestroyed()) e.sender.send(channel, data)
    })
  )
  handle('ask:cancel', (_e, id: string) => cancelAsk(id))

  handle('collections:list', () => getSettings().smartCollections)
  handle('settings:get', () => getSettings())
  handle('settings:set', (_e, patch: Partial<AppSettings>) => updateSettings(patch))

  handle('dictation:suggestions:list', () => listSuggestions())
  handle('dictation:suggestion:accept', (_e, key: string) => acceptSuggestion(key))
  handle('dictation:suggestion:dismiss', (_e, key: string) => dismissSuggestion(key))

  handle('providers:status', () => providersStatus())
  handle('enrichment:status', () => {
    const stats = enrichQueueStats()
    const run = enrichmentRunStats()
    return {
      enabled: getSettings().enrichment.enabled,
      queued: stats.queued,
      processed: run.processed,
      failed: stats.failed,
      lastError: run.lastError
    }
  })

  handle('capture:screenshot', async () => {
    // Hide the palette so it isn't in the shot, then invoke the system picker.
    hidePalette()
    const shot = await takeScreenshot()
    // Three outcomes, three messages. These used to share one `null`, so on a
    // platform with no region capture at all the app said "Capture cancelled" —
    // blaming the user for a dismissal that never happened.
    if ('unavailable' in shot) return { ok: false, error: shot.unavailable }
    if ('cancelled' in shot) return { ok: false, error: 'Capture cancelled' }
    const result = await capture.ingestImageFile(shot.path)
    if (!result) return { ok: false, error: 'Could not read captured image' }
    return { ok: true, id: result.id }
  })

  handle('rewrite:get', () => {
    const text = rewrite.getText()
    return text ? { text } : null
  })
  handle('rewrite:run', async (_e, payload: { prompt?: string }) => {
    const text = rewrite.getText()
    if (!text) return { ok: false, error: 'No selection to rewrite' }
    try {
      return { ok: true, output: await rewriteText(text, payload.prompt) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  handle('rewrite:apply', (_e, payload: { output: string }) =>
    paste.pasteRaw(payload.output, 'text')
  )

  /** Deterministic cleanup shared by every transcript: dictionary, numbers, style. */
  const correct = (raw: string): string => {
    const d = getSettings().dictation
    // Per-app override beats the global style. The destination was captured when
    // recording STARTED — by now the focused window may be our own HUD.
    const perApp = styleForApp(d.profiles, getDictationTarget())
    return correctTranscript(raw, {
      dictionary: d.dictionary,
      builtinVocabulary: d.builtinVocabulary,
      cleanup: d.cleanup,
      numbers: d.numbers !== false,
      style: perApp ?? d.style
    })
  }

  // Scratchpad and palette mic: a compressed recording, transcribed and returned.
  handle('scratch:transcribe', async (_e, payload: { audioB64: string; mime: string }) => {
    const audio = Buffer.from(payload.audioB64, 'base64')
    const path = saveRecording(audio, payload.mime)
    try {
      return { ok: true, text: correct(await transcribeFile(path, audio, payload.mime)) }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[dictation] transcription failed:', msg)
      return { ok: false, error: msg }
    } finally {
      rmSync(path, { force: true })
    }
  })

  /**
   * The compressed copy of a dictation take, kept only when keepAudio is on. It is
   * sent separately from the PCM so transcription never waits on MediaRecorder's
   * flush; the transcript handler picks the saved path up by take id.
   */
  const takeAudio = new Map<number, { promise: Promise<string | null>; resolve: (p: string | null) => void }>()
  const audioSlot = (take: number): { promise: Promise<string | null>; resolve: (p: string | null) => void } => {
    let slot = takeAudio.get(take)
    if (!slot) {
      let resolve!: (p: string | null) => void
      const promise = new Promise<string | null>((r) => (resolve = r))
      slot = { promise, resolve }
      takeAudio.set(take, slot)
      // Never leak a slot whose audio or transcript never arrives.
      setTimeout(() => takeAudio.delete(take), 60_000)
    }
    return slot
  }
  handle('dictation:audio', (_e, payload: { take: number; audioB64: string; mime: string }) => {
    const audio = Buffer.from(payload.audioB64, 'base64')
    audioSlot(payload.take).resolve(audio.length > 0 ? saveRecording(audio, payload.mime) : null)
  })

  handle(
    'dictation:transcribe',
    async (
      _e,
      payload: { take: number; pcm: Float32Array; micMs?: number; withAudio?: boolean }
    ) => {
      const take = rewrite.takeInfo(payload.take)
      const mode = take?.mode ?? 'paste'
      const seconds = payload.pcm.length / 16000
      const t0 = Date.now()
      // keepAudio: the compressed file arrives on its own channel moments after the
      // PCM. Waiting for it is bounded — losing the stored copy is acceptable,
      // stalling the paste on it is not.
      const audioPath = (): Promise<string | null> =>
        payload.withAudio
          ? Promise.race([
              audioSlot(payload.take).promise,
              new Promise<null>((r) => setTimeout(() => r(null), 2000))
            ]).finally(() => takeAudio.delete(payload.take))
          : Promise.resolve(null)
      let asr: { text: string; asrMs: number; warm: boolean }
      try {
        asr = await transcribePcm(payload.pcm)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[dictation] transcription failed:', msg)
        // Never lose the words: keep the take as a WAV the user can retry by hand.
        const kept = (await audioPath()) ?? saveRecording(pcmToWav(payload.pcm), 'audio/wav')
        return { ok: false, error: `${msg} (recording kept at ${kept})` }
      }
      let text = correct(asr.text)
      // The AI pass is opt-in per utterance: it only runs for a dictation started by
      // the second hotkey, so the default path never leaves the machine. A failure
      // or timeout here must never lose the words — fall through with the local text.
      if (mode === 'enhance') {
        try {
          text = await enhanceTranscript(text)
        } catch (err) {
          console.error('[dictate] AI cleanup failed; using the local transcript:', err)
        }
      }
      const timing = (): string =>
        `[dictate] timing take=${payload.take} ${asr.warm ? 'warm' : 'cold'} audio=${seconds.toFixed(1)}s ` +
        `mic=${payload.micMs ?? '?'}ms asr=${asr.asrMs}ms ` +
        `release→text=${take?.stoppedAt ? Date.now() - take.stoppedAt : '?'}ms handler=${Date.now() - t0}ms`
      const path = await audioPath()
      if (!text) {
        console.log(`${timing()} (empty)`)
        if (path) rmSync(path, { force: true })
        return { ok: false, error: 'Nothing was transcribed' }
      }

      const { id } = upsertClip({
        kind: 'text',
        content: text,
        preview: text.slice(0, 500),
        secret: false,
        derivedVia: path ? `dictation:${path}` : 'dictation'
      })
      updateEnrichment(id, { contentClass: 'transcription', tags: ['dictation'] })
      sendToPalette('items:changed', { reason: 'captured' })

      // Context-aware destination: dictating with the palette OPEN means the
      // words were for the ask box, not the app underneath — route the transcript
      // there instead of injecting a paste keystroke.
      const pal = getPalette()
      if (pal && !pal.isDestroyed() && pal.isVisible()) {
        console.log(timing())
        pal.webContents.send('palette:dictation', { text })
        return { ok: true, text, id, pasted: false }
      }

      // Remember what we pasted so a quick correction of it can become a
      // dictionary rule. Destination is the app captured when recording started.
      notePastedTranscript({ text, itemId: id, destKey: getDictationTarget() })
      console.log(timing())
      if (getSettings().dictation.autoPaste) {
        const outcome = await paste.pasteRaw(text, 'text')
        return { ok: true, text, id, pasted: outcome.method === 'injected' }
      }
      paste.setClipboardRaw(text, 'text')
      return { ok: true, text, id, pasted: false }
    }
  )

  handle('dictation:retry', async (_e, itemId: number) => {
    const item = getItem(itemId)
    const path = item?.derivedVia?.startsWith('dictation:') ? item.derivedVia.slice(10) : null
    if (!path || !existsSync(path)) {
      return { ok: false, error: 'Recordings are deleted after 2 days' }
    }
    try {
      const text = await transcribeFile(path)
      return { ok: true, text }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  handle('window:hide', (e) => {
    // Hide whichever window asked (palette hides; aux windows just hide too).
    const win = BrowserWindow.fromWebContents(e.sender)
    if (win && !win.isDestroyed()) win.hide()
    else hidePalette()
  })
  handle('data:export', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const stamp = new Date().toISOString().slice(0, 10)
    const { canceled, filePath } = await dialog.showSaveDialog(win ?? undefined!, {
      title: 'Export clipboard history',
      defaultPath: `clipboard-md-export-${stamp}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (canceled || !filePath) return { ok: false, error: 'Cancelled' }
    // Secret-flagged clips are deliberately omitted: an export is a plaintext file
    // that leaves the app's control, and shipping credentials into it is a trap.
    const items = exportAll().filter((i) => !i.secret)
    writeFileSync(
      filePath,
      JSON.stringify({ app: 'clipboard.md', version: app.getVersion(), exportedAt: Date.now(), items }, null, 2)
    )
    return { ok: true, path: filePath, count: items.length }
  })

  handle('window:open-settings', () => {
    hidePalette() // the palette is always-on-top; don't let it cover what we open
    openSettingsWindow()
  })
  handle('app:version', () => app.getVersion())
}
