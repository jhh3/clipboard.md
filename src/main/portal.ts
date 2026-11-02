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
const KEY_LEFTSHIFT = 42
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
/** Cached proxy: getProxyObject introspects over D-Bus every call (~10-30ms). */
let rdIface: dbus.ClientInterface | null = null

/**
 * How long an idle session is kept before we close it.
 *
 * Per-paste sessions cost a CreateSession/SelectDevices/Start round of portal
 * requests on every paste. A long-lived one makes back-to-back pastes instant, but
 * an open RemoteDesktop session lights GNOME's "input is being controlled" indicator,
 * and GNOME drops idle sessions on its own anyway. A few minutes of reuse covers a
 * burst of pastes; after that the next paste rebuilds it, in parallel with the focus
 * wait (see preparePortal), so the rebuild is mostly hidden.
 */
const IDLE_CLOSE_MS = 5 * 60_000
let idleTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Portal request caps. A silent restore (we hold a restore_token) answers in tens of
 * milliseconds; one that hangs must not hold a paste hostage for two minutes. The
 * first-ever Start shows a permission dialog and gets the long timeout.
 */
const FAST_TIMEOUT_MS = 3000
const DIALOG_TIMEOUT_MS = 120_000

function token(): string {
  return 'clipmd' + Math.floor(Math.random() * 1e9).toString(36)
}

async function getBus(): Promise<dbus.MessageBus> {
  if (!bus) {
    const b = dbus.sessionBus()
    // A dropped bus must not poison every later paste: forget it and the proxy so
    // the next call reconnects.
    b.on('error', (err: Error) => {
      console.error('[portal] session bus error:', err.message)
      if (bus === b) {
        bus = null
        rdIface = null
        sessionHandle = null
      }
    })
    bus = b
  }
  return bus
}

/**
 * Portal request pattern: the method returns a Request object path; the result
 * arrives as a Response(uint code, dict results) signal on that path. The request
 * object does not exist until the call is made, so it cannot be proxied up front —
 * instead we register a low-level signal match on the (predictable) path first.
 */
export async function portalCall(
  iface: dbus.ClientInterface,
  method: string,
  args: unknown[],
  options: Record<string, dbus.Variant>,
  // A connection other than the shared one (the GlobalShortcuts client needs its own,
  // registered with an app id), and how long to wait for the answer: null waits for
  // as long as a permission dialog stays on screen.
  via: { bus?: dbus.MessageBus; timeoutMs?: number | null } = {}
): Promise<Record<string, dbus.Variant>> {
  const b = via.bus ?? (await getBus())
  const timeoutMs = via.timeoutMs === undefined ? 120_000 : via.timeoutMs
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
    const timer =
      timeoutMs === null
        ? null
        : setTimeout(() => {
            low.removeListener('message', onMessage)
            reject(new Error(`portal ${method} timed out`))
          }, timeoutMs)
    const onMessage = (msg: dbus.Message): void => {
      if (
        msg.path === requestPath &&
        msg.interface === 'org.freedesktop.portal.Request' &&
        msg.member === 'Response'
      ) {
        if (timer) clearTimeout(timer)
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

async function remoteDesktop(): Promise<dbus.ClientInterface> {
  if (rdIface) return rdIface
  const b = await getBus()
  const obj = await b.getProxyObject(PORTAL_BUS, PORTAL_PATH)
  rdIface = obj.getInterface('org.freedesktop.portal.RemoteDesktop')
  return rdIface
}

async function ensureSession(): Promise<boolean> {
  if (sessionHandle) return true
  if (connecting) return connecting
  connecting = (async () => {
    const t0 = Date.now()
    try {
      const rd = await remoteDesktop()
      const fast = { timeoutMs: FAST_TIMEOUT_MS }

      const created = await portalCall(
        rd,
        'CreateSession',
        [],
        { session_handle_token: new dbus.Variant('s', token()) },
        fast
      )
      const session = created.session_handle?.value as string
      if (!session) throw new Error('no session handle')

      const selectOpts: Record<string, dbus.Variant> = {
        types: new dbus.Variant('u', 1), // KEYBOARD
        persist_mode: new dbus.Variant('u', 2) // persist until revoked
      }
      const savedToken = getSettings().pastePortalToken
      if (savedToken) selectOpts.restore_token = new dbus.Variant('s', savedToken)
      await portalCall(rd, 'SelectDevices', [session], selectOpts, fast)

      // Start pops the permission dialog on first run (or restores silently).
      const started = await portalCall(rd, 'Start', [session, ''], {}, {
        timeoutMs: savedToken ? FAST_TIMEOUT_MS : DIALOG_TIMEOUT_MS
      })
      const newToken = started.restore_token?.value as string | undefined
      if (newToken) updateSettings({ pastePortalToken: newToken })

      sessionHandle = session
      console.log(`[timing] portal-session ${Date.now() - t0}ms`)
      return true
    } catch (err) {
      console.error('[portal] session setup failed:', err)
      // A dead bus or proxy is the likeliest reason; rebuild both next time.
      rdIface = null
      return false
    } finally {
      connecting = null
    }
  })()
  return connecting
}

/**
 * Start (or reuse) the session without injecting anything. The paste path calls this
 * the moment a paste begins, so the portal handshake overlaps the clipboard write and
 * the focus hand-back instead of following them.
 */
export function preparePortal(): Promise<boolean> {
  return ensureSession()
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

async function attemptPaste(shift: boolean): Promise<Attempt> {
  if (!(await ensureSession())) return 'no-session'
  const rd = await remoteDesktop()
  const s = sessionHandle!
  const key = (code: number, down: boolean): Promise<unknown> =>
    rd.NotifyKeyboardKeycode(s, {}, code, down ? 1 : 0)
  // Each keystroke waits for the previous one's reply. Sending them all at once saved
  // a few milliseconds but left V held down in the target app, which then pasted on
  // key repeat until another key was pressed.
  //
  // First clear every modifier the compositor may still believe is held. The dictate
  // trigger is ITSELF a modifier combo (Ctrl+Alt+Shift+D on a macro pad), and a single
  // missed key-up leaves the compositor reading our injection as Ctrl+Alt+Shift+V —
  // not paste — while every step in the log says it worked. Releasing a key that is
  // already up is a no-op, so these are always safe to repeat on a retry.
  //
  // Which chord keys actually reached the compositor decides whether a retry is
  // safe, so they are counted rather than inferred from the error.
  let sent = 0
  try {
    for (const code of STRAY_MODIFIERS) await key(code, false)
    const chord: Array<[number, boolean]> = [
      [KEY_LEFTCTRL, true],
      ...(shift ? ([[KEY_LEFTSHIFT, true]] as Array<[number, boolean]>) : []),
      [KEY_V, true],
      [KEY_V, false],
      ...(shift ? ([[KEY_LEFTSHIFT, false]] as Array<[number, boolean]>) : []),
      [KEY_LEFTCTRL, false]
    ]
    for (const [code, down] of chord) {
      await key(code, down)
      sent++
    }
    return 'ok'
  } catch (err) {
    console.error('[portal] paste injection failed:', err)
    // Session may have died (compositor restart, revoked permission) — rebuild next time.
    sessionHandle = null
    if (sent > 0) {
      // V or a modifier may have gone down and never come back up. On a session that
      // still works that leaves it latched (V repeats, or the next keystroke is a
      // shortcut), so release all of them.
      for (const code of [KEY_V, KEY_LEFTSHIFT, KEY_LEFTCTRL]) {
        await key(code, false).catch(() => {
          /* the session is gone; the compositor drops its keys with it */
        })
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
 * Keep the session for the next paste, and close it after IDLE_CLOSE_MS of quiet.
 *
 * An open RemoteDesktop session keeps GNOME's red "your input is being controlled"
 * indicator lit, so it must not live forever; but rebuilding it per paste put three
 * portal round trips on every paste. Non-blocking either way.
 */
function scheduleIdleClose(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(releaseSession, IDLE_CLOSE_MS)
  idleTimer.unref?.()
}

function releaseSession(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
  const handle = sessionHandle
  sessionHandle = null
  if (handle) void closeSession(handle)
}

/**
 * Inject Ctrl+V into the focused window. Returns false on any failure.
 *
 * GNOME drops an idle RemoteDesktop session, so a reused handle can be stale
 * (`DBusError: Invalid session`). The retry covers exactly that: bounded to one extra
 * attempt on a fresh session, and only when nothing was injected, so it can't ever
 * paste twice.
 */
export async function portalPaste(shift = false): Promise<boolean> {
  const first = await attemptPaste(shift)
  if (first === 'ok') {
    scheduleIdleClose()
    return true
  }
  if (first !== 'stale') {
    releaseSession()
    return false
  }
  console.log('[portal] session was stale; retrying on a fresh one')
  const ok = (await attemptPaste(shift)) === 'ok'
  if (ok) scheduleIdleClose()
  else releaseSession()
  return ok
}

/** Close the session and forget the proxies (quit). */
export function stopPortal(): void {
  releaseSession()
  rdIface = null
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
