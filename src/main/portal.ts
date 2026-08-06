import * as dbus from 'dbus-next'
import { getSettings, updateSettings } from './settings'

/**
 * XDG RemoteDesktop portal keyboard injection — the sanctioned Wayland path for
 * auto-paste on GNOME. First use pops one system permission dialog; we request
 * persist_mode=2 and store the restore_token so later sessions skip the dialog
 * (where the compositor supports restore).
 *
 * Any failure at any step degrades to tier-0 (copy + toast) — never blocks a paste.
 */

const PORTAL_BUS = 'org.freedesktop.portal.Desktop'
const PORTAL_PATH = '/org/freedesktop/portal/desktop'
const KEY_LEFTCTRL = 29
const KEY_V = 47

let bus: dbus.MessageBus | null = null
let sessionHandle: string | null = null
let connecting: Promise<boolean> | null = null

function token(): string {
  return 'clipmd' + Math.floor(Math.random() * 1e9).toString(36)
}

async function getBus(): Promise<dbus.MessageBus> {
  if (!bus) bus = dbus.sessionBus()
  return bus
}

/**
 * Portal request pattern: method returns a Request object path; the result arrives
 * as a Response(uint code, dict results) signal on that path. We must subscribe
 * before calling to avoid the race.
 */
async function portalCall(
  iface: dbus.ClientInterface,
  method: string,
  args: unknown[],
  options: Record<string, dbus.Variant>
): Promise<Record<string, dbus.Variant>> {
  const b = await getBus()
  const handleToken = token()
  options.handle_token = new dbus.Variant('s', handleToken)

  // dbus-next's typings omit `name` (the bus's unique name, e.g. ":1.42").
  const uniqueName = (b as unknown as { name: string }).name
  const sender = uniqueName.slice(1).replace(/\./g, '_')
  const requestPath = `/org/freedesktop/portal/desktop/request/${sender}/${handleToken}`

  const responsePromise = new Promise<Record<string, dbus.Variant>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`portal ${method} timed out`)), 120_000)
    b.getProxyObject(PORTAL_BUS, requestPath)
      .then((reqObj) => {
        const req = reqObj.getInterface('org.freedesktop.portal.Request')
        req.once('Response', (code: number, results: Record<string, dbus.Variant>) => {
          clearTimeout(timer)
          if (Number(code) === 0) resolve(results)
          else reject(new Error(`portal ${method} denied/cancelled (code ${code})`))
        })
      })
      .catch((err) => {
        clearTimeout(timer)
        reject(err)
      })
  })

  await iface[method](...args, options)
  return responsePromise
}

async function ensureSession(): Promise<boolean> {
  if (sessionHandle) return true
  if (connecting) return connecting
  connecting = (async () => {
    try {
      const b = await getBus()
      const obj = await b.getProxyObject(PORTAL_BUS, PORTAL_PATH)
      const rd = obj.getInterface('org.freedesktop.portal.RemoteDesktop')

      const created = await portalCall(rd, 'CreateSession', [], {
        session_handle_token: new dbus.Variant('s', token())
      })
      const session = created.session_handle?.value as string
      if (!session) throw new Error('no session handle')

      const selectOpts: Record<string, dbus.Variant> = {
        types: new dbus.Variant('u', 1), // KEYBOARD
        persist_mode: new dbus.Variant('u', 2) // persist until revoked
      }
      const savedToken = getSettings().pastePortalToken
      if (savedToken) selectOpts.restore_token = new dbus.Variant('s', savedToken)
      await portalCall(rd, 'SelectDevices', [session], selectOpts)

      // Start pops the permission dialog on first run (or restores silently).
      const started = await portalCall(rd, 'Start', [session, ''], {})
      const newToken = started.restore_token?.value as string | undefined
      if (newToken) updateSettings({ pastePortalToken: newToken })

      sessionHandle = session
      return true
    } catch (err) {
      console.error('[portal] session setup failed:', err)
      return false
    } finally {
      connecting = null
    }
  })()
  return connecting
}

async function key(rd: dbus.ClientInterface, session: string, code: number, down: boolean): Promise<void> {
  await rd.NotifyKeyboardKeycode(session, {}, code, down ? 1 : 0)
}

/** Inject Ctrl+V into the focused window. Returns false on any failure. */
export async function portalPaste(): Promise<boolean> {
  try {
    if (!(await ensureSession())) return false
    const b = await getBus()
    const obj = await b.getProxyObject(PORTAL_BUS, PORTAL_PATH)
    const rd = obj.getInterface('org.freedesktop.portal.RemoteDesktop')
    const s = sessionHandle!
    await key(rd, s, KEY_LEFTCTRL, true)
    await key(rd, s, KEY_V, true)
    await key(rd, s, KEY_V, false)
    await key(rd, s, KEY_LEFTCTRL, false)
    return true
  } catch (err) {
    console.error('[portal] paste injection failed:', err)
    // Session may have died (compositor restart, revoked permission) — rebuild next time.
    sessionHandle = null
    return false
  }
}

/** Warm up the session (triggers the one-time permission dialog at a moment of our choosing). */
export async function portalWarmup(): Promise<boolean> {
  return ensureSession()
}
