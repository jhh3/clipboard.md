import { app, clipboard } from 'electron'
import { join } from 'path'
import { existsSync, writeFileSync } from 'fs'
import { openDb } from './store/db'
import { applyRetention } from './store/items'
import { CaptureService } from './capture'
import { PasteService } from './paste'
import { registerIpc } from './ipc'
import {
  createPaletteWindow,
  togglePalette,
  showPalette,
  hidePalette,
  sendToPalette,
  openScratchpadWindow,
  showDictationHud,
  stopDictation,
  hideDictationHud
} from './windows'
import { setupHotkeys, routeArgs, teardownHotkeys, type HotkeyActions } from './hotkeys'
import { getSettings, flushSettings } from './settings'
import { startEnrichment, drain as drainEnrichment, assignSession } from './enrichment'
import { startEmbeddings } from './embeddings'
import { setAiTransform } from './transforms'
import { complete } from './modelport'
import { portalScreenshot } from './portal'

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

// A background clipboard manager must never dialog-bomb the user: log and carry on.
// (Electron's default uncaught-exception handler shows a blocking error dialog.)
process.on('uncaughtException', (err) => {
  console.error('[main] uncaught exception:', err)
})
process.on('unhandledRejection', (reason) => {
  console.error('[main] unhandled rejection:', reason)
})

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
  // Second instance exists only to wake the first (GNOME keybindings run `--<action>`).
  app.quit()
} else {
  let pendingRewriteText: string | null = null
  let capture!: CaptureService
  let dictating = false

  const actions: HotkeyActions = {
    toggle: () => togglePalette(),
    rewrite: () => {
      // PRIMARY selection (what's highlighted right now) via the Xwayland bridge.
      const text =
        process.platform === 'linux' ? clipboard.readText('selection') : clipboard.readText()
      if (!text.trim()) {
        showPalette()
        return
      }
      pendingRewriteText = text
      showPalette()
      sendToPalette('palette:shown', { mode: 'rewrite', rewriteText: text })
    },
    screenshot: () => {
      void (async () => {
        const path = await portalScreenshot()
        if (path) capture.ingestImageFile(path)
      })()
    },
    scratchpad: () => openScratchpadWindow(),
    dictate: () => {
      // GNOME custom keybindings only fire on key-down, so the hotkey toggles:
      // press to start, press again (or Esc) to stop and transcribe.
      if (dictating) {
        dictating = false
        stopDictation()
      } else {
        dictating = true
        showDictationHud()
      }
    }
  }

  app.on('second-instance', (_e, argv) => {
    routeArgs(argv, actions)
  })

  app.whenReady().then(async () => {
    openDb(join(app.getPath('userData'), 'data'))

    capture = new CaptureService({
      onItem: (id, created) => {
        if (created) assignSession(id, Date.now())
        sendToPalette('items:changed', { reason: 'captured' })
        void drainEnrichment()
      }
    })
    const paste = new PasteService(capture, hidePalette)

    // AI transforms: the "my voice" system context rides along when samples exist.
    setAiTransform(async (prompt, content, imagePath, provider) => {
      const samples = getSettings().voiceSamples
      const system =
        samples.length > 0
          ? `Samples of the user's writing voice:\n${samples.map((s) => `---\n${s}`).join('\n')}\n---`
          : undefined
      return complete(
        'transforms',
        {
          system,
          prompt: `${prompt}\n\nINPUT:\n${content}`,
          imagePath,
          maxTokens: 4000
        },
        provider
      )
    })

    registerIpc(paste, capture, {
      getText: () => pendingRewriteText,
      onDictationDone: () => {
        dictating = false
        hideDictationHud()
      }
    })
    createPaletteWindow()
    capture.start()
    startEnrichment(() => sendToPalette('items:changed', { reason: 'enriched' }))
    startEmbeddings()
    await setupHotkeys(actions)

    // Housekeeping: retention pass on launch and daily.
    const runRetention = (): void => {
      const s = getSettings()
      applyRetention(s.retentionDays, s.maxItems)
    }
    runRetention()
    setInterval(runRetention, 24 * 60 * 60 * 1000)

    routeArgsOnLaunch()
  })

  function routeArgsOnLaunch(): void {
    if (process.argv.some((a) => ['--toggle', '--rewrite', '--capture', '--scratchpad'].includes(a))) {
      routeArgs(process.argv, actions)
    }
  }

  app.on('will-quit', () => {
    teardownHotkeys()
    flushSettings() // don't lose a debounced write on exit
  })

  // Tray-less background app: closing windows must not quit.
  app.on('window-all-closed', () => {
    /* keep running */
  })
}
