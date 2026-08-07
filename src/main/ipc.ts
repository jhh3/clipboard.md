import { app, ipcMain, nativeImage, BrowserWindow } from 'electron'
import { rmSync } from 'fs'
import type { SearchQuery, TransformRequest, AppSettings, SavedAction } from '@shared/types'
import {
  searchKeyword,
  searchHybrid,
  getItem,
  setPinned,
  deleteItem,
  enrichQueueStats,
  sessionsList,
  upsertClip,
  enqueueEnrichment,
  updateEnrichment
} from './store/items'
import { saveRecording, transcribeFile } from './transcribe'
import { runTransform, commitTransform } from './transforms'
import { getSettings, updateSettings } from './settings'
import { hidePalette, sendToPalette, openSettingsWindow, openScratchpadWindow } from './windows'
import type { PasteService } from './paste'
import type { CaptureService } from './capture'
import { providersStatus } from './modelport'
import { enrichmentRunStats } from './enrichment'
import { embedQuery } from './embeddings'
import { portalScreenshot } from './portal'

export interface RewriteState {
  getText: () => string | null
  onDictationDone: () => void
}

export function registerIpc(
  paste: PasteService,
  capture: CaptureService,
  rewrite: RewriteState
): void {
  ipcMain.handle('dictation:done', () => rewrite.onDictationDone())
  ipcMain.handle('search', async (_e, q: SearchQuery) => {
    if (q.mode === 'hybrid' && q.q.trim()) {
      const qe = await embedQuery(q.q)
      return searchHybrid(q, qe)
    }
    return searchKeyword(q)
  })

  ipcMain.handle('item:get', (_e, id: number) => getItem(id))
  ipcMain.handle('item:pin', (_e, id: number, pinned: boolean) => {
    setPinned(id, pinned)
    sendToPalette('items:changed', { reason: 'transformed' })
  })
  ipcMain.handle('item:delete', (_e, id: number) => {
    deleteItem(id)
    sendToPalette('items:changed', { reason: 'deleted' })
  })
  ipcMain.handle('item:paste', (_e, id: number, opts: { plain?: boolean }) =>
    paste.pasteItem(id, !!opts?.plain)
  )
  ipcMain.handle('item:copy', (_e, id: number) => paste.copyItem(id))
  ipcMain.handle('item:image-data', (_e, id: number) => {
    const item = getItem(id)
    if (!item || item.kind !== 'image') return null
    const img = nativeImage.createFromPath(item.content)
    return img.isEmpty() ? null : img.toDataURL()
  })

  ipcMain.handle('transform:run', (_e, req: TransformRequest) => runTransform(req))
  ipcMain.handle(
    'transform:commit',
    (_e, req: TransformRequest & { output: string; outputKind: 'text' | 'image' }) => {
      const id = commitTransform(req)
      sendToPalette('items:changed', { reason: 'transformed' })
      return id
    }
  )
  ipcMain.handle(
    'transform:paste-output',
    (_e, payload: { output: string; outputKind: 'text' | 'image'; plain?: boolean }) =>
      paste.pasteRaw(payload.output, payload.outputKind)
  )

  ipcMain.handle('actions:list', (_e, kind: 'text' | 'image') =>
    getSettings().savedActions.filter((a) => a.appliesTo.includes(kind))
  )
  ipcMain.handle('actions:save', (_e, action: SavedAction) => {
    const actions = getSettings().savedActions.filter((a) => a.id !== action.id)
    updateSettings({ savedActions: [...actions, action] })
  })
  ipcMain.handle('actions:delete', (_e, id: string) => {
    updateSettings({ savedActions: getSettings().savedActions.filter((a) => a.id !== id) })
  })

  ipcMain.handle('collections:list', () => getSettings().smartCollections)
  ipcMain.handle('sessions:list', () =>
    sessionsList().map((s) => ({
      id: s.id,
      title: s.title,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      count: s.count
    }))
  )

  ipcMain.handle('settings:get', () => getSettings())
  ipcMain.handle('settings:set', (_e, patch: Partial<AppSettings>) => updateSettings(patch))

  ipcMain.handle('providers:status', () => providersStatus())
  ipcMain.handle('enrichment:status', () => {
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

  ipcMain.handle('capture:screenshot', async () => {
    // Hide the palette so it isn't in the shot, then invoke GNOME's picker.
    hidePalette()
    const path = await portalScreenshot()
    if (!path) return { ok: false, error: 'Capture cancelled or portal unavailable' }
    const result = capture.ingestImageFile(path)
    if (!result) return { ok: false, error: 'Could not read captured image' }
    return { ok: true, id: result.id }
  })

  ipcMain.handle('rewrite:get', () => {
    const text = rewrite.getText()
    return text ? { text } : null
  })
  ipcMain.handle('rewrite:apply', (_e, payload: { output: string }) =>
    paste.pasteRaw(payload.output, 'text')
  )

  ipcMain.handle(
    'scratch:transcribe',
    async (_e, payload: { audioB64: string; mime: string; dictation?: boolean }) => {
      const audio = Buffer.from(payload.audioB64, 'base64')
      // Persist first when retries are wanted: a failed transcript shouldn't cost the
      // user their words. With keepAudio off we still need a temp file to decode from,
      // but it's removed once transcription finishes.
      const keep = getSettings().dictation.keepAudio
      const path = saveRecording(audio, payload.mime)
      const cleanup = (): void => {
        if (keep) return
        for (const p of [path, path.replace(/\.[^.]+$/, '.16k.wav')]) {
          try {
            rmSync(p, { force: true })
          } catch {
            /* best effort */
          }
        }
      }
      try {
        const text = await transcribeFile(path, audio, payload.mime)
        cleanup()
        if (!payload.dictation) return { ok: true, text }
        if (!text) return { ok: false, error: 'Nothing was transcribed' }

        const { id } = upsertClip({
          kind: 'text',
          content: text,
          preview: text.slice(0, 500),
          secret: false,
          derivedVia: keep ? `dictation:${path}` : 'dictation'
        })
        updateEnrichment(id, { contentClass: 'transcription', tags: ['dictation'] })
        sendToPalette('items:changed', { reason: 'captured' })

        if (getSettings().dictation.autoPaste) {
          const outcome = await paste.pasteRaw(text, 'text')
          return { ok: true, text, id, pasted: outcome.method === 'injected' }
        }
        paste.setClipboardRaw(text, 'text')
        return { ok: true, text, id, pasted: false }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { ok: false, error: keep ? `${msg} (recording kept at ${path})` : msg }
      }
    }
  )

  ipcMain.handle('dictation:retry', async (_e, itemId: number) => {
    const item = getItem(itemId)
    const path = item?.derivedVia?.startsWith('dictation:') ? item.derivedVia.slice(10) : null
    if (!path) return { ok: false, error: 'No stored recording for this item' }
    try {
      const text = await transcribeFile(path)
      return { ok: true, text }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('scratch:save', (_e, payload: { text: string; itemId?: number }) => {
    const { id, created } = upsertClip({
      kind: 'text',
      content: payload.text,
      preview: payload.text.slice(0, 500),
      secret: false,
      derivedFrom: payload.itemId,
      derivedVia: payload.itemId ? 'scratchpad edit' : undefined
    })
    if (created && getSettings().enrichment.enabled) enqueueEnrichment(id)
    sendToPalette('items:changed', { reason: 'captured' })
    return id
  })

  ipcMain.handle('window:hide', (e) => {
    // Hide whichever window asked (palette hides; aux windows just hide too).
    const win = BrowserWindow.fromWebContents(e.sender)
    if (win && !win.isDestroyed()) win.hide()
    else hidePalette()
  })
  ipcMain.handle('window:open-settings', () => openSettingsWindow())
  ipcMain.handle('window:open-scratchpad', (_e, itemId?: number) => openScratchpadWindow(itemId))
  ipcMain.handle('app:version', () => app.getVersion())
}
