import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import * as dbus from 'dbus-next'
import { portalCall } from './portal'

/**
 * Dictation keys through the XDG GlobalShortcuts portal: a real press AND release,
 * delivered as D-Bus signals, with nothing spawned.
 *
 * Why not the GNOME custom keybinding: it runs a COMMAND, and GNOME re-runs it on
 * every key repeat. Holding the chord to talk produced one `sh -c 'gdbus …'` every
 * 30ms, and gsd-media-keys starts a transient systemd scope for each one. Those
 * scopes were never collected — ~18,000 of them piled up in a few days and kept
 * systemd --user at ~100% CPU, which slowed the entire desktop. The portal has no
 * command to run, and Deactivated is the release we otherwise had to infer from
 * repeats stopping.
 *
 * GNOME asks the user once, in its own dialog, before granting the shortcuts. The
 * bind therefore waits without a timeout: the answer arrives whenever they click.
 */

/** Must name a .desktop file, or the portal refuses to register the app id. */
const APP_ID = 'md.clipboard.app'
const PORTAL_BUS = 'org.freedesktop.portal.Desktop'
const PORTAL_PATH = '/org/freedesktop/portal/desktop'

export interface PortalShortcut {
  id: string
  description: string
  /** `CTRL+ALT+space` — see shared/chord.ts toPortalTrigger. */
  trigger: string
}

export interface PortalShortcutHandlers {
  onActivated: (id: string) => void
  onDeactivated: (id: string) => void
  /** The portal session ended underneath us; the shortcuts no longer fire. */
  onLost: () => void
}

let bus: dbus.MessageBus | null = null
let session: string | null = null
/** Bumped on every (re)bind, so a dialog answered late cannot revive a stale bind. */
let generation = 0

/**
 * The portal resolves a host app's id through its .desktop file, and an AppImage
 * installs none. Written to the user's applications dir, hidden from the app grid.
 */
function ensureDesktopEntry(): void {
  const dir = join(homedir(), '.local', 'share', 'applications')
  const file = join(dir, `${APP_ID}.desktop`)
  const exec = process.env.APPIMAGE
    ? `"${process.env.APPIMAGE}"`
    : app.isPackaged
      ? `"${process.execPath}"`
      : `"${process.execPath}" "${app.getAppPath()}"`
  const content = [
    '[Desktop Entry]',
    'Type=Application',
    'Name=clipboard.md',
    'Comment=Local-first AI clipboard manager',
    `Exec=${exec}`,
    'Icon=clipboard-md',
    'Terminal=false',
    'NoDisplay=true',
    'Categories=Utility;',
    'StartupWMClass=clipboard-md',
    ''
  ].join('\n')
  if (existsSync(file) && readFileSync(file, 'utf8') === content) return
  mkdirSync(dir, { recursive: true })
  writeFileSync(file, content)
}

/**
 * Bind the dictation shortcuts. Resolves to the ids the portal granted, or null when
 * the portal is missing, refuses, or the user declined — the caller then keeps the
 * GNOME keybindings. Calling again replaces the previous bind.
 */
export async function bindPortalShortcuts(
  shortcuts: PortalShortcut[],
  handlers: PortalShortcutHandlers
): Promise<Set<string> | null> {
  stopPortalShortcuts()
  if (shortcuts.length === 0) return null
  const mine = ++generation
  const b = dbus.sessionBus()
  bus = b
  try {
    ensureDesktopEntry()
    const obj = await b.getProxyObject(PORTAL_BUS, PORTAL_PATH)
    // getInterface throws when this portal version has no GlobalShortcuts.
    const gs = obj.getInterface('org.freedesktop.portal.GlobalShortcuts')
    // Register must be the first portal call on this connection.
    await obj.getInterface('org.freedesktop.host.portal.Registry').Register(APP_ID, {})

    const token = (): string => 'clipmd' + Math.floor(Math.random() * 1e9).toString(36)
    const created = await portalCall(gs, 'CreateSession', [], {
      session_handle_token: new dbus.Variant('s', token())
    }, { bus: b })
    const handle = created.session_handle?.value as string | undefined
    if (!handle) throw new Error('no session handle')
    if (mine !== generation) return null
    session = handle

    gs.on('Activated', (s: string, id: string) => {
      if (s === session) handlers.onActivated(id)
    })
    gs.on('Deactivated', (s: string, id: string) => {
      if (s === session) handlers.onDeactivated(id)
    })
    const sessionObj = await b.getProxyObject(PORTAL_BUS, handle)
    sessionObj.getInterface('org.freedesktop.portal.Session').on('Closed', () => {
      if (mine !== generation) return
      console.log('[shortcuts] portal session closed')
      session = null
      handlers.onLost()
    })

    const request = shortcuts.map((s) => [
      s.id,
      {
        description: new dbus.Variant('s', s.description),
        preferred_trigger: new dbus.Variant('s', s.trigger)
      }
    ])
    const bound = await portalCall(gs, 'BindShortcuts', [handle, request, ''], {}, {
      bus: b,
      timeoutMs: null
    })
    if (mine !== generation) return null
    const granted = new Set(
      ((bound.shortcuts?.value ?? []) as Array<[string, Record<string, dbus.Variant>]>).map(
        ([id]) => id
      )
    )
    console.log(`[shortcuts] portal granted ${[...granted].join(', ') || 'nothing'}`)
    return granted.size > 0 ? granted : null
  } catch (err) {
    if (mine === generation) {
      console.log(`[shortcuts] GlobalShortcuts portal unavailable: ${(err as Error).message ?? err}`)
      stopPortalShortcuts()
    }
    return null
  }
}

export function stopPortalShortcuts(): void {
  generation++
  session = null
  if (bus) {
    // Disconnecting closes every portal session this connection owns.
    bus.disconnect()
    bus = null
  }
}
