import { app } from 'electron'
import { writeFileSync, mkdirSync, existsSync, rmSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

/**
 * Keep the app resident. The global hotkeys are GNOME custom keybindings that run
 * `<binary> --toggle`; if nothing is running that means paying a full Electron cold
 * start (~6s) before anything appears, which reads as "the shortcut is broken".
 */
function autostartFile(): string {
  return join(homedir(), '.config', 'autostart', 'clipboard-md.desktop')
}

export function isAutostartEnabled(): boolean {
  return existsSync(autostartFile())
}

export function setAutostart(enabled: boolean): void {
  const file = autostartFile()
  if (!enabled) {
    rmSync(file, { force: true })
    return
  }
  const exec = app.isPackaged
    ? process.execPath
    : `${process.execPath} ${app.getAppPath()}`
  mkdirSync(join(homedir(), '.config', 'autostart'), { recursive: true })
  writeFileSync(
    file,
    [
      '[Desktop Entry]',
      'Type=Application',
      'Name=clipboard.md',
      'Comment=Local-first AI clipboard manager',
      `Exec=${exec}`,
      'Terminal=false',
      'X-GNOME-Autostart-enabled=true',
      // Give the session a moment so the compositor and portals are up first.
      'X-GNOME-Autostart-Delay=3',
      'NoDisplay=false',
      ''
    ].join('\n')
  )
}
