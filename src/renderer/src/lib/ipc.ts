/**
 * Thin typed wrapper over the preload bridge (`window.clipmd`).
 * All IPC in the renderer goes through these two functions.
 */
import type { IpcEventMap, IpcInvokeMap } from '@shared/types'

export type InvokeChannel = keyof IpcInvokeMap
export type EventChannel = keyof IpcEventMap

export function invoke<C extends InvokeChannel>(
  channel: C,
  ...args: Parameters<IpcInvokeMap[C]>
): Promise<ReturnType<IpcInvokeMap[C]>> {
  return window.clipmd.invoke(channel, ...args)
}

/** Subscribe to a main-process event. Returns an unsubscribe function. */
export function on<C extends EventChannel>(
  channel: C,
  cb: (payload: IpcEventMap[C]) => void
): () => void {
  return window.clipmd.on(channel, cb)
}
