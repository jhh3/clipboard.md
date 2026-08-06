import { app } from 'electron'
import { join } from 'path'
import { openDb } from './store/db'
import { applyRetention } from './store/items'
import { CaptureService } from './capture'
import { PasteService } from './paste'
import { registerIpc } from './ipc'
import { createPaletteWindow, togglePalette, hidePalette, sendToPalette } from './windows'
import { setupHotkeys, teardownHotkeys } from './hotkeys'
import { getSettings } from './settings'

// Linux: run under Xwayland deliberately. Mutter's Xwayland bridge is the one
// clipboard path verified to work focuslessly on GNOME Wayland (DESIGN.md §2),
// and it restores window positioning that native-Wayland Electron lacks.
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('ozone-platform', 'x11')
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  // Second instance exists only to wake the first (GNOME keybinding runs `--toggle`).
  app.quit()
} else {
  app.on('second-instance', () => {
    togglePalette()
  })

  app.whenReady().then(async () => {
    openDb(join(app.getPath('userData'), 'data'))

    const capture = new CaptureService({
      onItem: () => sendToPalette('items:changed', { reason: 'captured' })
    })
    const paste = new PasteService(capture, hidePalette)

    registerIpc(paste)
    createPaletteWindow()
    capture.start()
    await setupHotkeys(togglePalette)

    // Housekeeping: retention pass on launch and daily.
    const runRetention = () => {
      const s = getSettings()
      applyRetention(s.retentionDays, s.maxItems)
    }
    runRetention()
    setInterval(runRetention, 24 * 60 * 60 * 1000)

    // Started via keybinding with --toggle: show immediately.
    if (process.argv.includes('--toggle')) togglePalette()
  })

  app.on('will-quit', () => teardownHotkeys())

  // Tray-less background app: closing windows must not quit.
  app.on('window-all-closed', () => {
    /* keep running */
  })
}
