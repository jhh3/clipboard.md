import { app, globalShortcut } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileP = promisify(execFile)

export interface HotkeyActions {
  toggle: () => void
  rewrite: () => void
  screenshot: () => void
  scratchpad: () => void
  /** Push-to-talk dictation: toggles recording (GNOME keybindings can't report key-up). */
  dictate: () => void
}

/**
 * Hotkey strategy per platform:
 *  - darwin: Electron globalShortcut (reliable).
 *  - linux/GNOME Wayland: globalShortcut is dead (mutter ≥49 killed Xwayland grabs).
 *    We register GNOME custom keybindings that run `<binary> --<action>`; the second
 *    instance hits our single-instance lock and wakes the running app.
 */
export async function setupHotkeys(actions: HotkeyActions): Promise<void> {
  if (process.platform === 'darwin') {
    globalShortcut.register('Command+Shift+V', actions.toggle)
    globalShortcut.register('Command+Shift+R', actions.rewrite)
    globalShortcut.register('Command+Shift+S', actions.screenshot)
    globalShortcut.register('Command+Shift+E', actions.scratchpad)
    globalShortcut.register('Command+Shift+D', actions.dictate)
    return
  }
  await ensureGnomeKeybindings()
}

interface Binding {
  slug: string
  name: string
  binding: string
  arg: string
}

const BINDINGS: Binding[] = [
  { slug: 'clipboard-md', name: 'clipboard.md — palette', binding: '<Control><Alt>v', arg: '--toggle' },
  { slug: 'clipboard-md-rewrite', name: 'clipboard.md — rewrite selection', binding: '<Control><Alt>r', arg: '--rewrite' },
  { slug: 'clipboard-md-shot', name: 'clipboard.md — screenshot', binding: '<Control><Alt>s', arg: '--capture' },
  { slug: 'clipboard-md-scratch', name: 'clipboard.md — scratchpad', binding: '<Control><Alt>e', arg: '--scratchpad' },
  { slug: 'clipboard-md-dictate', name: 'clipboard.md — dictate', binding: '<Control><Alt>d', arg: '--dictate' }
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
    const cmdBase = app.isPackaged
      ? process.execPath
      : `${process.execPath} ${app.getAppPath()}`
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
      await gsettings(['set', ...key, 'name', b.name])
      await gsettings(['set', ...key, 'command', `${cmdBase} ${b.arg}`])
      if (!current || current === '@as []' || current === b.binding) {
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
  if (argv.includes('--rewrite')) actions.rewrite()
  else if (argv.includes('--capture')) actions.screenshot()
  else if (argv.includes('--scratchpad')) actions.scratchpad()
  else if (argv.includes('--dictate')) actions.dictate()
  else actions.toggle()
}

export function teardownHotkeys(): void {
  globalShortcut.unregisterAll()
}
