import { LINUX } from './platform'

/**
 * One long-lived X11 connection for every hot path that needs to ask X something.
 *
 * Before this, each copy spawned two `xprop` processes to name the source app, each
 * paste spawned two more (plus a 60ms retry) to name the target, the paste path
 * polled `xclip -o` every 25ms to learn when our own write had taken the selection,
 * and capture opened a fresh X connection on every unlock and resume without ever
 * closing the old one. All of those are cheap round trips on a connection we keep.
 *
 * Event subscriptions made once at connect:
 *  - XFixes SetSelectionOwner on CLIPBOARD: capture's change signal, and the paste
 *    path's proof that xclip really owns the selection.
 *  - PropertyChange on the root window: _NET_ACTIVE_WINDOW changes, which is how the
 *    paste path knows focus has landed back on the target instead of sleeping.
 *
 * Every caller must treat `null` as "no X here" and fall back; nothing in this
 * module throws.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

interface Conn {
  X: any
  root: number
  clipboard: number
  activeWindow: number
  /** Whether XFixes is there, i.e. selection-owner events arrive. */
  fixes: boolean
}

type Listener = (ev: { owner: number }) => void

let conn: Promise<Conn | null> | null = null
let live: Conn | null = null
const ownerListeners = new Set<Listener>()
const activeListeners = new Set<() => void>()
const lostListeners = new Set<() => void>()
/** Bumped whenever CLIPBOARD gets a new (non-None) owner, so a waiter can ask "has it changed since?". */
let ownerChanges = 0

const CONNECT_TIMEOUT_MS = 3000
const REQUEST_TIMEOUT_MS = 400

function drop(why: string): void {
  if (!live && !conn) return
  console.error(`[x11] connection lost: ${why}`)
  try {
    live?.X.terminate()
  } catch {
    /* already gone */
  }
  live = null
  conn = null
  for (const l of lostListeners) l()
}

/** The shared connection, created on first use. Resolves null when X is unavailable. */
export function xconn(): Promise<Conn | null> {
  if (!LINUX) return Promise.resolve(null)
  if (conn) return conn
  conn = new Promise<Conn | null>((resolve) => {
    let settled = false
    const done = (c: Conn | null, why?: string): void => {
      if (settled) return
      settled = true
      if (!c) {
        console.error(`[x11] unavailable: ${why}`)
        conn = null
      }
      live = c
      resolve(c)
    }
    setTimeout(() => done(null, 'timed out connecting to X'), CONNECT_TIMEOUT_MS).unref?.()
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const x11 = require('x11') as { createClient: (cb: (err: Error | null, d: any) => void) => void }
      x11.createClient((err, display) => {
        if (err) return done(null, err.message)
        const X = display.client
        const root: number = display.screen[0].root
        X.on('error', (e: Error) => console.error('[x11] error:', e.message))
        X.on('end', () => drop('server closed the connection'))
        const intern = (name: string): Promise<number> =>
          new Promise((res, rej) => X.InternAtom(false, name, (e: Error | null, a: number) => (e ? rej(e) : res(a))))
        void Promise.all([
          intern('CLIPBOARD'),
          intern('_NET_ACTIVE_WINDOW')
        ])
          .then(([clipboard, activeWindow]) => {
            const c: Conn = { X, root, clipboard, activeWindow, fixes: false }
            X.ChangeWindowAttributes(root, { eventMask: 0x00400000 /* PropertyChange */ })
            X.on('event', (ev: { name?: string; atom?: number; owner?: number; selection?: number }) => {
              if (ev.name === 'PropertyNotify' && ev.atom === activeWindow) {
                for (const l of activeListeners) l()
              } else if (ev.name === 'SelectionNotify' && ev.selection === clipboard) {
                if (ev.owner) ownerChanges++
                for (const l of ownerListeners) l({ owner: ev.owner ?? 0 })
              }
            })
            X.require('fixes', (ferr: Error | null, Fixes: any) => {
              // Without XFixes we still serve property reads; only owner events are lost.
              if (ferr) console.error(`[x11] fixes extension unavailable: ${ferr.message}`)
              else Fixes.SelectSelectionInput(root, clipboard, 1 /* SetSelectionOwner */)
              c.fixes = !ferr
              done(c)
            })
          })
          .catch((e: Error) => done(null, `InternAtom: ${e.message}`))
      })
    } catch (e) {
      done(null, String(e))
    }
  })
  return conn
}

/** True when the shared connection is up. */
export function xReady(): boolean {
  return live !== null
}

/** True when the shared connection is up and receives selection-owner events. */
export function hasOwnerEvents(): boolean {
  return !!live?.fixes
}

/** Subscribe to CLIPBOARD owner changes. Returns the unsubscribe. */
export function onClipboardOwnerChange(cb: Listener): () => void {
  ownerListeners.add(cb)
  return () => ownerListeners.delete(cb)
}

/** Subscribe to the shared connection dying (X server restart). */
export function onXLost(cb: () => void): () => void {
  lostListeners.add(cb)
  return () => lostListeners.delete(cb)
}

export function ownerChangeCount(): number {
  return ownerChanges
}

/**
 * Resolve once the CLIPBOARD owner has changed since `since` (an ownerChangeCount()
 * taken BEFORE the write), or false after timeoutMs.
 */
export function waitForOwnerChange(since: number, timeoutMs: number): Promise<boolean> {
  if (ownerChanges > since) return Promise.resolve(true)
  return new Promise((resolve) => {
    const off = onClipboardOwnerChange((ev) => {
      if (ev.owner === 0) return // owner went away, not a new one
      clearTimeout(timer)
      off()
      resolve(true)
    })
    const timer = setTimeout(() => {
      off()
      resolve(false)
    }, timeoutMs)
  })
}

/**
 * Resolve on the next _NET_ACTIVE_WINDOW change, or false after timeoutMs.
 * Subscribe BEFORE doing whatever moves focus, via the returned `wait`.
 */
export function armActiveWindowChange(): { wait: (timeoutMs: number) => Promise<boolean>; cancel: () => void } {
  let fired = false
  let wake: (() => void) | null = null
  const l = (): void => {
    fired = true
    wake?.()
  }
  activeListeners.add(l)
  const cancel = (): void => void activeListeners.delete(l)
  return {
    cancel,
    wait: (timeoutMs) =>
      new Promise<boolean>((resolve) => {
        if (fired) {
          fired = false
          return resolve(true)
        }
        const timer = setTimeout(() => {
          wake = null
          resolve(false)
        }, timeoutMs)
        wake = () => {
          clearTimeout(timer)
          wake = null
          fired = false
          resolve(true)
        }
      })
  }
}

function getProperty(c: Conn, wid: number, atom: number, type = 0, longs = 64): Promise<{ type: number; data: Buffer } | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), REQUEST_TIMEOUT_MS)
    try {
      c.X.GetProperty(0, wid, atom, type, 0, longs, (err: Error | null, prop: { type: number; data: Buffer }) => {
        clearTimeout(timer)
        resolve(err ? null : prop)
      })
    } catch {
      clearTimeout(timer)
      resolve(null)
    }
  })
}

/** The X11 active window id, 0 when none (focus is on a native Wayland window, or in flight). */
export async function activeWindow(): Promise<number> {
  const c = await xconn()
  if (!c) return 0
  const prop = await getProperty(c, c.root, c.activeWindow, 33 /* WINDOW */, 1)
  return prop && prop.data.length >= 4 ? prop.data.readUInt32LE(0) : 0
}

/** WM_CLASS of a window as [instance, class]. */
async function wmClassOf(c: Conn, wid: number): Promise<[string, string] | null> {
  const prop = await getProperty(c, wid, 67 /* WM_CLASS */, 31 /* STRING */, 64)
  if (!prop || prop.data.length === 0) return null
  const [instance = '', cls = ''] = prop.data.toString('latin1').split('\0')
  return [instance, cls]
}

/**
 * WM_CLASS of the focused X11 window — the class half when present, else the
 * instance — or null when nothing X11 is focused. Same answer `xprop` gave, one
 * round trip instead of two process spawns.
 */
export async function activeWmClass(): Promise<string | null> {
  const c = await xconn()
  if (!c) return null
  const wid = await activeWindow()
  if (!wid) return null
  const pair = await wmClassOf(c, wid)
  if (!pair) return null
  return pair[1] || pair[0] || null
}

/** Close the shared connection (quit). */
export function closeX(): void {
  const c = live
  live = null
  conn = null
  ownerListeners.clear()
  activeListeners.clear()
  lostListeners.clear()
  try {
    c?.X.terminate()
  } catch {
    /* already gone */
  }
}
