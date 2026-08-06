import { app } from 'electron'
import { join } from 'path'
import { existsSync, writeFileSync } from 'fs'
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
const gpuFallbackFlag = (): string => join(app.getPath('userData'), 'force-software-gpu')

if (process.platform === 'linux') {
  app.commandLine.appendSwitch('ozone-platform', 'x11')
  // The GPU process sandbox cannot open Mesa's dri_gbm.so on this Ubuntu/NVIDIA
  // setup (the file is world-readable — it's the sandbox, not permissions), which
  // crash-loops the GPU process and can leave the transparent window unpainted.
  // Loosen only the GPU process sandbox; the renderer sandbox is unaffected.
  app.commandLine.appendSwitch('disable-gpu-sandbox')
  app.commandLine.appendSwitch('ignore-gpu-blocklist')
  // Auto-detected fallback: if HW accel crash-looped before, this flag file exists
  // and we run software-rendered. Delete the file to retry hardware acceleration.
  if (existsSync(gpuFallbackFlag())) app.disableHardwareAcceleration()
}

// Watchdog: if the GPU process crash-loops at runtime, persist the fallback flag
// and relaunch in software mode — intelligent degradation instead of a blanket off.
let gpuCrashes = 0
app.on('child-process-gone', (_e, details) => {
  if (details.type === 'GPU' && ['crashed', 'abnormal-exit', 'launch-failed'].includes(details.reason)) {
    gpuCrashes++
    if (gpuCrashes >= 3 && !existsSync(gpuFallbackFlag())) {
      writeFileSync(
        gpuFallbackFlag(),
        'GPU process crash-looped; running software-rendered. Delete this file to retry HW accel.\n'
      )
      app.relaunch()
      app.exit(0)
    }
  }
})

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
