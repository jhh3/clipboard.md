import { app } from 'electron'
import { writeFileSync, mkdirSync, existsSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { MACOS, WIN32 } from './platform'

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
  if (MACOS) return app.getLoginItemSettings().openAtLogin
  if (WIN32) return windowsLoginItem().openAtLogin
  return existsSync(autostartFile())
}

/**
 * Windows login-item state, read back for the EXACT command we would write.
 *
 * `getLoginItemSettings()` with no arguments answers about the running executable's
 * default registration, which is not what we wrote — we register with `--background`.
 * Passing the same path and args back means a stale entry (an old install location,
 * an upgrade that moved the exe) reports false, and the self-repair in index.ts
 * rewrites it. Without that, the entry rots and the app silently stops starting at
 * login while Settings still shows the toggle on. That is exactly the failure the
 * Linux TryExec staleness check exists for.
 */
function windowsLoginItem(): Electron.LoginItemSettings {
  return app.getLoginItemSettings({ path: process.execPath, args: ['--background'] })
}

/**
 * True when an autostart entry exists but no longer points at a binary that runs.
 *
 * "Enabled" only ever asked whether the FILE exists, so a stale entry was never
 * repaired: the startup check is `if (!isAutostartEnabled()) setAutostart(true)`,
 * which is satisfied by a file naming a binary that is long gone. Observed exactly
 * that — an entry pointing into the pnpm store at
 * `electron@43.2.0_supports-color@7.2.0`, a path that changed on the next install,
 * so the app silently stopped starting at login. An AppImage that gets moved or
 * replaced produces the same rot.
 *
 * Checked against the command we would write now, and against the target actually
 * existing on disk.
 */
export function autostartIsStale(): boolean {
  if (MACOS) return false
  // Windows has no separate staleness question: isAutostartEnabled() already asks
  // about this exact executable and these exact args, so a stale entry shows up
  // there as "not enabled" and is rewritten by the same self-repair.
  if (WIN32) return false
  const file = autostartFile()
  if (!existsSync(file)) return false
  try {
    const content = readFileSync(file, 'utf8')
    const exec = /^Exec=(.*)$/m.exec(content)?.[1]?.trim()
    if (exec !== launchCommand()) return true
    const tryExec = /^TryExec=(.*)$/m.exec(content)?.[1]?.trim()
    return !!tryExec && !existsSync(tryExec)
  } catch {
    // Unreadable is as good as wrong — rewriting it is safe and idempotent.
    return true
  }
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
  if (MACOS) {
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
  if (WIN32) {
    // The previous code fell through to the branch below and wrote an XDG
    // `.desktop` file into %USERPROFILE%\.config\autostart — a directory Windows
    // has never heard of. isAutostartEnabled() then found that file and reported
    // autostart ENABLED, forever, while nothing whatsoever started at login.
    app.setLoginItemSettings({
      openAtLogin: enabled,
      path: process.execPath,
      args: ['--background'],
      name: 'clipboard.md'
    })
    const state = windowsLoginItem()
    // Two different facts, and only the log can tell them apart: whether OUR registry
    // entry exists, and whether Windows will actually honour it. Task Manager ▸
    // Startup can disable a login item without removing it, so a user who switched
    // it off there would otherwise see us "successfully" re-enable it every launch.
    console.log(
      `[autostart] windows login item: openAtLogin=${state.openAtLogin} ` +
        `willLaunch=${state.executableWillLaunchAtLogin} items=${state.launchItems?.length ?? 0}`
    )
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
