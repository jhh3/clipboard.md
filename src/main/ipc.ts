import { app, ipcMain, nativeImage, BrowserWindow, dialog } from 'electron'
import { rmSync, writeFileSync } from 'fs'
import { isTrustedSender } from './security'
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
  updateEnrichment,
  exportAll
} from './store/items'
import { saveRecording, transcribeFile } from './transcribe'
import { detectSecret } from './capture/filters'
import { runTransform, commitTransform } from './transforms'
import { getSettings, updateSettings } from './settings'
import { hidePalette, sendToPalette, broadcast, openSettingsWindow, openScratchpadWindow } from './windows'
import {
  listNotes,
  getNote,
  createNote,
  updateNote,
  backlinks,
  outgoingLinks,
  findNoteByTitle,
  resolveLinksTo,
  dailyNote
} from './store/notes'
import type { PasteService } from './paste'
import type { CaptureService } from './capture'
import { providersStatus } from './modelport'
import { enrichmentRunStats } from './enrichment'
import { embedQuery } from './embeddings'
import { takeScreenshot } from './screenshot'

export interface RewriteState {
  getText: () => string | null
  onDictationDone: () => void
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
  handle('dictation:done', () => rewrite.onDictationDone())

  // ── notes ────────────────────────────────────────────────────────────────
  handle('notes:list', (_e, opts: { q?: string } = {}) => listNotes(opts))
  handle('notes:get', (_e, id: number) => getNote(id))
  handle('notes:create', (_e, input?: { title?: string; content?: string }) => {
    const id = createNote(input ?? {})
    const note = getNote(id)
    // A note created after something already linked to it by title must adopt those
    // edges, or the backlink never appears and the feature looks broken.
    if (note?.title) resolveLinksTo(id, note.title)
    broadcast('notes:changed', { id })
    return id
  })
  handle('notes:update', (_e, id: number, patch: { title?: string; content?: string }) => {
    updateNote(id, patch)
    const note = getNote(id)
    if (note?.title) resolveLinksTo(id, note.title)
    // Notes are edited constantly; only tell other windows, not the editor that
    // just typed, and let the list re-read on its own schedule.
    broadcast('notes:changed', { id })
  })
  handle('notes:delete', (_e, id: number) => {
    deleteItem(id)
    broadcast('notes:changed', { id })
  })
  handle('notes:backlinks', (_e, id: number) => backlinks(id))
  handle('notes:outgoing', (_e, id: number) => outgoingLinks(id))
  handle('notes:open-by-title', (_e, title: string) => {
    const existing = findNoteByTitle(title)
    if (existing !== null) return existing
    // Following a link to a note that doesn't exist creates it — the wiki behaviour
    // users expect, and the reason unresolved edges are stored in the first place.
    const id = createNote({ title, content: `# ${title}\n\n` })
    resolveLinksTo(id, title)
    broadcast('notes:changed', { id })
    return id
  })
  handle('notes:daily', () => {
    const id = dailyNote()
    broadcast('notes:changed', { id })
    return id
  })
  handle('search', async (_e, q: SearchQuery) => {
    if (q.mode === 'hybrid' && q.q.trim()) {
      const qe = await embedQuery(q.q)
      return searchHybrid(q, qe)
    }
    return searchKeyword(q)
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

  handle('transform:run', (_e, req: TransformRequest) => runTransform(req))
  handle(
    'transform:commit',
    (_e, req: TransformRequest & { output: string; outputKind: 'text' | 'image' }) => {
      const id = commitTransform(req)
      sendToPalette('items:changed', { reason: 'transformed' })
      return id
    }
  )
  handle(
    'transform:paste-output',
    (_e, payload: { output: string; outputKind: 'text' | 'image'; plain?: boolean }) =>
      paste.pasteRaw(payload.output, payload.outputKind)
  )

  handle('actions:list', (_e, kind: 'text' | 'image') =>
    getSettings().savedActions.filter((a) => a.appliesTo.includes(kind))
  )
  handle('actions:save', (_e, action: SavedAction) => {
    const actions = getSettings().savedActions.filter((a) => a.id !== action.id)
    updateSettings({ savedActions: [...actions, action] })
  })
  handle('actions:delete', (_e, id: string) => {
    updateSettings({ savedActions: getSettings().savedActions.filter((a) => a.id !== id) })
  })

  handle('collections:list', () => getSettings().smartCollections)
  handle('sessions:list', () =>
    sessionsList().map((s) => ({
      id: s.id,
      title: s.title,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      count: s.count
    }))
  )

  handle('settings:get', () => getSettings())
  handle('settings:set', (_e, patch: Partial<AppSettings>) => updateSettings(patch))

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
    const path = await takeScreenshot()
    if (!path) return { ok: false, error: 'Capture cancelled' }
    const result = capture.ingestImageFile(path)
    if (!result) return { ok: false, error: 'Could not read captured image' }
    return { ok: true, id: result.id }
  })

  handle('rewrite:get', () => {
    const text = rewrite.getText()
    return text ? { text } : null
  })
  handle('rewrite:apply', (_e, payload: { output: string }) =>
    paste.pasteRaw(payload.output, 'text')
  )

  handle(
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
        // Log it: returning the error to the renderer only put it in a toast that
        // vanished, so transcription failures left no trace to debug from.
        console.error('[dictation] transcription failed:', msg)
        return { ok: false, error: keep ? `${msg} (recording kept at ${path})` : msg }
      }
    }
  )

  handle('dictation:retry', async (_e, itemId: number) => {
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
  handle('scratch:save', (_e, payload: { text: string; itemId?: number }) => {
    // This path receives raw selections (rewrite hotkey) and scratchpad text, so it
    // must run the same secret scan as capture — otherwise highlighting an API key
    // and hitting rewrite stored it indexed, embedded and queued for enrichment.
    const secret = detectSecret(payload.text) !== null
    const { id, created } = upsertClip({
      kind: 'text',
      content: payload.text,
      preview: payload.text.slice(0, 500),
      secret,
      derivedFrom: payload.itemId,
      derivedVia: payload.itemId ? 'scratchpad edit' : undefined
    })
    if (created && !secret && getSettings().enrichment.enabled) enqueueEnrichment(id)
    sendToPalette('items:changed', { reason: 'captured' })
    return id
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
  handle('window:open-scratchpad', (_e, itemId?: number) => {
    hidePalette()
    openScratchpadWindow(itemId)
  })
  handle('app:version', () => app.getVersion())
}
