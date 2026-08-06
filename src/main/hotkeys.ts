import { app, globalShortcut } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileP = promisify(execFile)

/**
 * Hotkey strategy per platform:
 *  - darwin: Electron globalShortcut (reliable).
 *  - linux/GNOME Wayland: globalShortcut is dead (mutter ≥49 killed Xwayland grabs).
 *    We register a GNOME custom keybinding that runs `<binary> --toggle`; the second
 *    instance hits our single-instance lock and wakes the palette.
 */
export async function setupHotkeys(toggle: () => void): Promise<void> {
  if (process.platform === 'darwin') {
    globalShortcut.register('Command+Shift+V', toggle)
    return
  }
  await ensureGnomeKeybinding()
}

const KEYBIND_PATH =
  '/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/clipboard-md/'
const LIST_KEY = 'org.gnome.settings-daemon.plugins.media-keys custom-keybindings'
const ENTRY_SCHEMA = `org.gnome.settings-daemon.plugins.media-keys.custom-keybinding:${KEYBIND_PATH}`

async function gsettings(args: string[]): Promise<string> {
  const { stdout } = await execFileP('gsettings', args)
  return stdout.trim()
}

/** Idempotently register Ctrl+Alt+V → `<app> --toggle` as a GNOME custom shortcut. */
export async function ensureGnomeKeybinding(): Promise<boolean> {
  try {
    const current = await gsettings(['get', ...LIST_KEY.split(' ')])
    if (!current.includes(KEYBIND_PATH)) {
      const list: string[] = current === '@as []' ? [] : JSON.parse(current.replace(/'/g, '"'))
      list.push(KEYBIND_PATH)
      const ser = '[' + list.map((p) => `'${p}'`).join(', ') + ']'
      await gsettings(['set', ...LIST_KEY.split(' '), ser])
    }
    // In dev, process.execPath is electron; route through the CLI wrapper if packaged.
    const cmd = app.isPackaged
      ? `${process.execPath} --toggle`
      : `${process.execPath} ${app.getAppPath()} --toggle`
    await gsettings(['set', ...ENTRY_SCHEMA.split(' '), 'name', 'clipboard.md'])
    await gsettings(['set', ...ENTRY_SCHEMA.split(' '), 'command', cmd])
    await gsettings(['set', ...ENTRY_SCHEMA.split(' '), 'binding', '<Control><Alt>v'])
    return true
  } catch (err) {
    console.error('[hotkeys] failed to register GNOME keybinding:', err)
    return false
  }
}

export function teardownHotkeys(): void {
  globalShortcut.unregisterAll()
}
