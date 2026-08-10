import * as dbus from 'dbus-next'
import { getSettings, updateSettings } from './settings'
import { MOD_CODES } from '@shared/chord'

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

/**
 * Every modifier keycode, both sides. Released before we synthesise Ctrl+V so the
 * compositor's idea of what is held cannot corrupt the chord we are injecting.
 * Sourced from the chord table so it can never drift from the trigger side.
 */
const STRAY_MODIFIERS: number[] = [
  ...MOD_CODES.ctrl,
  ...MOD_CODES.alt,
  ...MOD_CODES.shift,
  ...MOD_CODES.meta
]

let bus: dbus.MessageBus | null = null
let sessionHandle: string | null = null
let connecting: Promise<boolean> | null = null

/**
 * How long to let mutter drain the keystrokes we just queued before closing the
 * session. The Notify calls have already returned by then; this is only insurance
 * against tearing down the transport underneath in-flight input.
 */
const SESSION_CLOSE_DELAY_MS = 250

function token(): string {
  return 'clipmd' + Math.floor(Math.random() * 1e9).toString(36)
}

async function getBus(): Promise<dbus.MessageBus> {
  if (!bus) bus = dbus.sessionBus()
  return bus
}

/**
 * Portal request pattern: the method returns a Request object path; the result
 * arrives as a Response(uint code, dict results) signal on that path. The request
 * object does not exist until the call is made, so it cannot be proxied up front —
 * instead we register a low-level signal match on the (predictable) path first.
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

  // dbus-next's typings omit `name` (unique bus name) and the low-level surface.
  const low = b as unknown as {
    name: string
    _addMatch: (rule: string) => Promise<unknown>
    on: (ev: 'message', cb: (msg: dbus.Message) => void) => void
    removeListener: (ev: 'message', cb: (msg: dbus.Message) => void) => void
  }
  const sender = low.name.slice(1).replace(/\./g, '_')
  const requestPath = `/org/freedesktop/portal/desktop/request/${sender}/${handleToken}`

  await low._addMatch(
    `type='signal',interface='org.freedesktop.portal.Request',member='Response',path='${requestPath}'`
  )

  const responsePromise = new Promise<Record<string, dbus.Variant>>((resolve, reject) => {
    const timer = setTimeout(() => {
      low.removeListener('message', onMessage)
      reject(new Error(`portal ${method} timed out`))
    }, 120_000)
    const onMessage = (msg: dbus.Message): void => {
      if (
        msg.path === requestPath &&
        msg.interface === 'org.freedesktop.portal.Request' &&
        msg.member === 'Response'
      ) {
        clearTimeout(timer)
        low.removeListener('message', onMessage)
        const [code, results] = msg.body as [number, Record<string, dbus.Variant>]
        if (Number(code) === 0) resolve(results ?? {})
        else reject(new Error(`portal ${method} denied/cancelled (code ${code})`))
      }
    }
    low.on('message', onMessage)
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

type Attempt =
  /** Ctrl+V was delivered. */
  | 'ok'
  /** Never got a session at all — retrying immediately would fail the same way. */
  | 'no-session'
  /** The session was stale and nothing was injected: safe to retry on a fresh one. */
  | 'stale'
  /** Some keys landed before the failure — retrying could paste twice. */
  | 'partial'

async function attemptPaste(): Promise<Attempt> {
  if (!(await ensureSession())) return 'no-session'
  const b = await getBus()
  const obj = await b.getProxyObject(PORTAL_BUS, PORTAL_PATH)
  const rd = obj.getInterface('org.freedesktop.portal.RemoteDesktop')
  const s = sessionHandle!
  // Which keystrokes actually reached the compositor decides whether a retry is
  // safe, so it has to be counted rather than inferred from the error.
  let sent = 0
  try {
    // Clear every modifier the compositor may still believe is held, before
    // synthesising our own chord. The dictate trigger is ITSELF a modifier combo —
    // Ctrl+Alt+Shift+D on a macro pad — and a single missed key-up (an evdev grab
    // swallowing it, keyd's virtual device desyncing) leaves the compositor reading
    // our injection as Ctrl+Alt+Shift+V. That is not paste, so the transcript lands
    // nowhere while every step in the log still says it worked.
    //
    // Deliberately NOT counted in `sent`: releasing a key that is already up is a
    // no-op, so it is always safe to repeat on a retry.
    for (const code of STRAY_MODIFIERS) await key(rd, s, code, false)
    await key(rd, s, KEY_LEFTCTRL, true)
    sent++
    await key(rd, s, KEY_V, true)
    sent++
    await key(rd, s, KEY_V, false)
    sent++
    await key(rd, s, KEY_LEFTCTRL, false)
    sent++
    return 'ok'
  } catch (err) {
    console.error('[portal] paste injection failed:', err)
    // Session may have died (compositor restart, revoked permission) — rebuild next time.
    sessionHandle = null
    if (sent > 0) {
      // Ctrl went down and never came back up. On a session that still works that
      // leaves the modifier latched, and the user's next keystroke is a shortcut.
      try {
        await key(rd, s, KEY_LEFTCTRL, false)
      } catch {
        /* the session is gone; the compositor drops its keys with it */
      }
      return 'partial'
    }
    return 'stale'
  }
}

/** Close a session we are done with, best effort — it may already be gone. */
async function closeSession(handle: string): Promise<void> {
  try {
    const b = await getBus()
    const obj = await b.getProxyObject(PORTAL_BUS, handle)
    await obj.getInterface('org.freedesktop.portal.Session').Close()
  } catch {
    /* already torn down by the compositor */
  }
}

/**
 * Give up the session as soon as the paste is done.
 *
 * An open RemoteDesktop session keeps GNOME's red "your input is being controlled"
 * indicator lit in the top bar for as long as it lives — and ours lived forever,
 * because nothing ever closed it. It read as a stuck microphone light. Holding the
 * right to synthesise keystrokes indefinitely is also just more authority than a
 * paste needs; we want it for the ~10ms we are using it.
 *
 * Non-blocking: the paste has already been delivered, so the caller must not wait
 * on teardown. The handle is dropped immediately so the next paste builds a fresh
 * session rather than racing this close.
 */
function releaseSession(): void {
  const handle = sessionHandle
  sessionHandle = null
  if (!handle) return
  setTimeout(() => void closeSession(handle), SESSION_CLOSE_DELAY_MS).unref()
}

/**
 * Inject Ctrl+V into the focused window. Returns false on any failure.
 *
 * GNOME drops an idle RemoteDesktop session, so pastes alternated between working
 * and `DBusError: Invalid session` (measured: eight consecutive dictations, every
 * other one lost). Clearing the handle on failure meant the NEXT paste rebuilt the
 * session and succeeded — the discovery was paid for with the user's paste, which
 * degraded silently to "it's on your clipboard".
 *
 * Now the session is per-paste: built, used, closed. That removes the stale-handle
 * window entirely rather than papering over it. The retry stays as a safety net for
 * a session that dies between Start and the first keystroke — bounded to one extra
 * attempt, and only when nothing was injected, so it can't ever paste twice.
 */
export async function portalPaste(): Promise<boolean> {
  const first = await attemptPaste()
  if (first === 'ok') {
    releaseSession()
    return true
  }
  if (first !== 'stale') {
    releaseSession()
    return false
  }
  console.log('[portal] session was stale; retrying on a fresh one')
  const ok = (await attemptPaste()) === 'ok'
  releaseSession()
  return ok
}

/**
 * Warm up (triggers the one-time permission dialog at a moment of our choosing, and
 * banks the restore_token so later sessions are silent). The session itself is then
 * released — warming up must not leave the red indicator lit until the first paste.
 */
export async function portalWarmup(): Promise<boolean> {
  const ok = await ensureSession()
  releaseSession()
  return ok
}

/**
 * Interactive screenshot via the Screenshot portal: GNOME shows its own
 * area/window/screen picker and returns a file:// URI of the capture.
 */
export async function portalScreenshot(): Promise<string | null> {
  try {
    const b = await getBus()
    const obj = await b.getProxyObject(PORTAL_BUS, PORTAL_PATH)
    const shot = obj.getInterface('org.freedesktop.portal.Screenshot')
    const results = await portalCall(shot, 'Screenshot', [''], {
      interactive: new dbus.Variant('b', true)
    })
    const uri = results.uri?.value as string | undefined
    if (!uri?.startsWith('file://')) return null
    return decodeURIComponent(uri.slice(7))
  } catch (err) {
    console.error('[portal] screenshot failed:', err)
    return null
  }
}
