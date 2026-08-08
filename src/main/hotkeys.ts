import { app, globalShortcut } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { DBUS_NAME, DBUS_PATH, DBUS_IFACE } from './dbusService'

const execFileP = promisify(execFile)

export interface HotkeyActions {
  toggle: () => void
  rewrite: () => void
  screenshot: () => void
  scratchpad: () => void
  /** Push-to-talk dictation: toggles recording (GNOME keybindings can't report key-up). */
  dictate: () => void
  notes: () => void
}

/**
 * Hotkey strategy per platform:
 *  - darwin: Electron globalShortcut (reliable).
 *  - linux/GNOME Wayland: globalShortcut is dead (mutter ≥49 killed Xwayland grabs).
 *    We register GNOME custom keybindings that run `<binary> --<action>`; the second
 *    instance hits our single-instance lock and wakes the running app.
 */
/** macOS accelerators, in the order they're reported when registration fails. */
const MAC_SHORTCUTS: Array<[string, keyof HotkeyActions]> = [
  ['Command+Shift+V', 'toggle'],
  ['Command+Shift+R', 'rewrite'],
  ['Command+Shift+S', 'screenshot'],
  ['Command+Shift+E', 'scratchpad'],
  ['Command+Shift+D', 'dictate'],
  ['Command+Shift+N', 'notes']
]

export async function setupHotkeys(actions: HotkeyActions): Promise<void> {
  if (process.platform === 'darwin') {
    // register() returns false when something else already owns the combination —
    // another app, or a system shortcut. Ignoring that return value is how a hotkey
    // ends up "just not working" with nothing anywhere to explain why. macOS has no
    // API to name the owner, so the honest thing is to say which one failed.
    const failed: string[] = []
    for (const [accelerator, action] of MAC_SHORTCUTS) {
      if (!globalShortcut.register(accelerator, actions[action])) failed.push(accelerator)
    }
    if (failed.length > 0) {
      console.error(
        `[hotkeys] could not register ${failed.join(', ')} — another app or a system ` +
          'shortcut already owns them. Change or free the conflicting shortcut.'
      )
    } else {
      console.log(`[hotkeys] registered ${MAC_SHORTCUTS.length} global shortcuts`)
    }
    return
  }
  await ensureGnomeKeybindings()
}

interface Binding {
  slug: string
  name: string
  binding: string
  arg: string
  /** Defaults we shipped previously — safe to migrate away from, unlike a user rebind. */
  previous?: string[]
}

const BINDINGS: Binding[] = [
  { slug: 'clipboard-md', name: 'clipboard.md — palette', binding: '<Control><Alt>v', arg: '--toggle' },
  { slug: 'clipboard-md-rewrite', name: 'clipboard.md — rewrite selection', binding: '<Control><Alt>r', arg: '--rewrite' },
  { slug: 'clipboard-md-shot', name: 'clipboard.md — screenshot', binding: '<Control><Alt>s', arg: '--capture' },
  { slug: 'clipboard-md-scratch', name: 'clipboard.md — scratchpad', binding: '<Control><Alt>e', arg: '--scratchpad' },
  {
    slug: 'clipboard-md-dictate',
    name: 'clipboard.md — dictate (hold to talk)',
    // Ctrl+Alt+D is GNOME's built-in "show desktop" — it hid every window.
    // Space is also far nicer to hold down for push-to-talk.
    binding: '<Control><Alt>space',
    arg: '--dictate',
    previous: ['<Control><Alt>d']
  },
  { slug: 'clipboard-md-notes', name: 'clipboard.md — notes', binding: '<Control><Alt>n', arg: '--notes' }
]

const LIST_KEY = 'org.gnome.settings-daemon.plugins.media-keys custom-keybindings'

async function gsettings(args: string[]): Promise<string> {
  const { stdout } = await execFileP('gsettings', args)
  return stdout.trim()
}

export async function ensureGnomeKeybindings(): Promise<boolean> {
  try {
    const current = await gsettings(['get', ...LIST_KEY.split(' ')])
    const list: string[] = current === '@as []' ? [] : JSON.parse(current.replace(/'/g, '"'))
    let changed = false
    for (const b of BINDINGS) {
      const path = `/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/${b.slug}/`
      if (!list.includes(path)) {
        list.push(path)
        changed = true
      }
    }
    if (changed) {
      await gsettings(['set', ...LIST_KEY.split(' '), '[' + list.map((p) => `'${p}'`).join(', ') + ']'])
    }
    const launch = app.isPackaged
      ? `"${process.execPath}"`
      : `"${process.execPath}" "${app.getAppPath()}"`
    for (const b of BINDINGS) {
      const schema = `org.gnome.settings-daemon.plugins.media-keys.custom-keybinding:/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/${b.slug}/`
      const key = schema.split(' ')
      // Command/name are ours to own — the binding is not. If the user rebound it,
      // leave their choice alone; only write the default when it's unset or still
      // matches what we last wrote. (We were clobbering rebinds on every launch.)
      const current = (await gsettings(['get', ...key, 'binding']).catch(() => "''")).replace(
        /^'|'$/g,
        ''
      )
      // Prefer gdbus (a few ms) over launching Electron (~1-3s, and GNOME re-runs
      // the command on every key repeat). Fall back to the binary if the app isn't
      // running yet, so a cold hotkey press still starts it.
      const action = b.arg.replace(/^--/, '')
      const gdbus =
        `gdbus call --session --dest ${DBUS_NAME} --object-path ${DBUS_PATH} ` +
        `--method ${DBUS_IFACE}.Trigger ${action}`
      const command = `sh -c '${gdbus} >/dev/null 2>&1 || ${launch} ${b.arg}'`
      await gsettings(['set', ...key, 'name', b.name])
      await gsettings(['set', ...key, 'command', command])
      // Write the default only when the slot is empty, already ours, or still holds
      // a default we used to ship (so a bad pick can be corrected). A binding the
      // user chose themselves is never touched.
      const ours = !current || current === '@as []' || current === b.binding
      const staleDefault = (b.previous ?? []).includes(current)
      if (ours || staleDefault) {
        if (staleDefault) console.log(`[hotkeys] migrating ${b.slug}: ${current} -> ${b.binding}`)
        await gsettings(['set', ...key, 'binding', b.binding])
      } else {
        console.log(`[hotkeys] keeping user binding for ${b.slug}: ${current}`)
      }
    }
    return true
  } catch (err) {
    console.error('[hotkeys] failed to register GNOME keybindings:', err)
    return false
  }
}

/** Every CLI flag that maps to an action — keep in sync with routeArgs. */
export const ACTION_FLAGS = BINDINGS.map((b) => b.arg)

/** Route a second-instance argv to the matching action. */
export function routeArgs(argv: string[], actions: HotkeyActions): void {
  // --background is a session-start launch: stay resident, show nothing.
  if (argv.includes('--background')) return
  if (argv.includes('--rewrite')) actions.rewrite()
  else if (argv.includes('--capture')) actions.screenshot()
  else if (argv.includes('--scratchpad')) actions.scratchpad()
  else if (argv.includes('--dictate')) actions.dictate()
  else if (argv.includes('--notes')) actions.notes()
  else actions.toggle()
}

export function teardownHotkeys(): void {
  globalShortcut.unregisterAll()
}
