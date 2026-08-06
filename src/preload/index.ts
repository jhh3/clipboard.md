import { contextBridge, ipcRenderer } from 'electron'
import type { IpcEventMap, IpcInvokeMap } from '@shared/types'

type InvokeChannel = keyof IpcInvokeMap
type EventChannel = keyof IpcEventMap

const api = {
  invoke<C extends InvokeChannel>(
    channel: C,
    ...args: Parameters<IpcInvokeMap[C]>
  ): Promise<ReturnType<IpcInvokeMap[C]>> {
    return ipcRenderer.invoke(channel, ...args)
  },
  on<C extends EventChannel>(channel: C, cb: (payload: IpcEventMap[C]) => void): () => void {
    const listener = (_e: Electron.IpcRendererEvent, payload: IpcEventMap[C]) => cb(payload)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  }
}

export type PreloadApi = typeof api

contextBridge.exposeInMainWorld('clipmd', api)
