import { app } from 'electron'
import { writeFileSync, mkdirSync, existsSync, rmSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

/**
 * Keep the app resident. The global hotkeys are GNOME custom keybindings that run
 * `<binary> --toggle`; if nothing is running that means paying a full Electron cold
 * start before anything appears, which reads as "the shortcut is broken".
 *
 * Linux only writes an XDG autostart entry: app.setLoginItemSettings has been a
 * no-op on Linux for years (electron#32388). macOS uses the real API.
 */
function autostartFile(): string {
  return join(homedir(), '.config', 'autostart', 'clipboard-md.desktop')
}

export function isAutostartEnabled(): boolean {
  if (process.platform === 'darwin') return app.getLoginItemSettings().openAtLogin
  return existsSync(autostartFile())
}

/**
 * The executable to relaunch at login. Under AppImage, `process.execPath` points
 * inside the ephemeral FUSE mount (/tmp/.mount_XXXX/...) which does not exist after
 * the app exits — the autostart entry would silently never start again. The
 * APPIMAGE env var holds the real, stable path.
 */
function launchCommand(): string {
  if (process.env.APPIMAGE) return `"${process.env.APPIMAGE}" --background`
  if (app.isPackaged) return `"${process.execPath}" --background`
  return `"${process.execPath}" "${app.getAppPath()}" --background`
}

export function setAutostart(enabled: boolean): void {
  if (process.platform === 'darwin') {
    // openAsHidden is the macOS way to say "start without showing a window"; the
    // --background argv flag is still passed because routeArgsOnLaunch reads it, and
    // openAsHidden alone is advisory (and ignored outside a packaged .app).
    app.setLoginItemSettings({
      openAtLogin: enabled,
      openAsHidden: enabled,
      args: ['--background']
    })
    return
  }
  const file = autostartFile()
  if (!enabled) {
    rmSync(file, { force: true })
    return
  }
  const exec = launchCommand()
  const tryExec = process.env.APPIMAGE ?? process.execPath
  mkdirSync(join(homedir(), '.config', 'autostart'), { recursive: true })
  writeFileSync(
    file,
    [
      '[Desktop Entry]',
      'Type=Application',
      'Name=clipboard.md',
      'Comment=Local-first AI clipboard manager',
      `Exec=${exec}`,
      // If the binary moves, the entry no-ops instead of erroring at every login.
      `TryExec=${tryExec}`,
      'Terminal=false',
      'X-GNOME-Autostart-enabled=true',
      'NoDisplay=false',
      ''
    ].join('\n')
  )
}
