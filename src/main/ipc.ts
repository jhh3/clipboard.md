import { app, ipcMain } from 'electron'
import type { SearchQuery, TransformRequest, AppSettings, SavedAction } from '@shared/types'
import {
  searchKeyword,
  getItem,
  setPinned,
  deleteItem,
  enrichQueueStats
} from './store/items'
import { runTransform, commitTransform } from './transforms'
import { getSettings, updateSettings } from './settings'
import { hidePalette, sendToPalette } from './windows'
import type { PasteService } from './paste'

export function registerIpc(paste: PasteService): void {
  ipcMain.handle('search', (_e, q: SearchQuery) => {
    // Hybrid mode arrives with the embeddings milestone; keyword covers both until then.
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
    (_e, payload: { output: string; outputKind: 'text' | 'image' }) =>
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

  ipcMain.handle('settings:get', () => getSettings())
  ipcMain.handle('settings:set', (_e, patch: Partial<AppSettings>) => updateSettings(patch))

  ipcMain.handle('providers:status', () => [])
  ipcMain.handle('enrichment:status', () => {
    const stats = enrichQueueStats()
    return {
      enabled: getSettings().enrichment.enabled,
      queued: stats.queued,
      processed: 0,
      failed: stats.failed
    }
  })

  ipcMain.handle('window:hide', () => hidePalette())
  ipcMain.handle('app:version', () => app.getVersion())
}
