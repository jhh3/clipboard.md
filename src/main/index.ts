import { app, powerMonitor, BrowserWindow } from 'electron'
import { readPrimarySelection } from './capture/clipboardIO'
import { isAutostartEnabled, setAutostart } from './autostart'
import { join } from 'path'
import { existsSync, writeFileSync } from 'fs'
import { openDb, closeDb, maintainDb } from './store/db'
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
  broadcast,
  openScratchpadWindow,
  showDictationHud,
  stopDictation,
  hideDictationHud
} from './windows'
import { setupHotkeys, routeArgs, teardownHotkeys, ACTION_FLAGS, type HotkeyActions } from './hotkeys'
import { getSettings, flushSettings, onSettingsChanged } from './settings'
import { startEnrichment, drain as drainEnrichment, assignSession } from './enrichment'
import { startEmbeddings, stopEmbeddings } from './embeddings'
import { setAiTransform } from './transforms'
import { complete } from './modelport'
import { portalScreenshot } from './portal'
import { hardenApp, applyPermissionPolicy } from './security'
import { initLogging, closeLogging } from './log'

const gpuFallbackFlag = (): string => join(app.getPath('userData'), 'force-software-gpu')

if (process.platform === 'linux') {
  // Let Electron use its native Wayland backend (default since 38.2; we're on 43).
  // We previously forced Xwayland to get focusless clipboard access — obsolete now
  // that every clipboard read/write happens out-of-process (capture/clipboardIO),
  // and forcing it is what gave us blurry HiDPI, wrong-monitor placement and the
  // janky drag behaviour that native Wayland windows simply don't have.
  app.commandLine.appendSwitch('ozone-platform-hint', 'auto')
  // The GPU process sandbox cannot open Mesa's dri_gbm.so on this Ubuntu/NVIDIA
  // setup (the file is world-readable — it's the sandbox, not permissions), which
  // crash-loops the GPU process and can leave the transparent window unpainted.
  // Loosen only the GPU process sandbox; the renderer sandbox is unaffected.
  app.commandLine.appendSwitch('disable-gpu-sandbox')
  app.commandLine.appendSwitch('ignore-gpu-blocklist')
}

// Chromium features a background clipboard manager has no use for. Read-then-append,
// because repeated appendSwitch calls overwrite rather than merge:
//  - SpareRendererForSitePerProcess pre-launches an entire spare renderer we will
//    never navigate into
//  - CalculateNativeWinOcclusion does periodic work for a window that is hidden
//    most of its life
disableFeatures('SpareRendererForSitePerProcess,CalculateNativeWinOcclusion,HardwareMediaKeyHandling')

// Auto-detected fallback: if HW accel crash-looped before, this flag file exists and
// we run software-rendered. Delete the file to retry hardware acceleration.
if (existsSync(gpuFallbackFlag())) {
  app.disableHardwareAcceleration()
  // disableHardwareAcceleration alone doesn't set the command-line switch, and
  // several Chromium subsystems check that switch directly (electron#51363).
  app.commandLine.appendSwitch('disable-gpu')
}

function disableFeatures(list: string): void {
  const existing = app.commandLine.getSwitchValue('disable-features')
  app.commandLine.appendSwitch('disable-features', existing ? `${list},${existing}` : list)
}

// A background clipboard manager must never dialog-bomb the user (Electron's
// default handler shows a blocking error dialog). But it must also not limp on
// after the main process is in an unknown state while holding an open SQLite
// write handle — that is how databases get corrupted. So: log, close the DB
// cleanly, then exit. Autostart brings us back.
let fatalHandled = false
process.on('uncaughtException', (err) => {
  console.error('[main] uncaught exception:', err)
  if (fatalHandled) return
  fatalHandled = true
  try {
    flushSettings()
    closeDb()
    closeLogging()
  } catch (e) {
    console.error('[main] shutdown after fatal error failed:', e)
  }
  app.exit(1)
})

// Rejections are routinely recoverable here (a provider timing out, a portal
// call being cancelled), so these are logged and survived rather than fatal.
process.on('unhandledRejection', (reason) => {
  console.error('[main] unhandled rejection:', reason)
})

// A renderer crashing must not take capture down with it — recreate the window.
app.on('render-process-gone', (_e, contents, details) => {
  if (details.reason === 'clean-exit') return
  console.error(`[main] renderer gone (${details.reason}); it will be recreated on next use`)
  const win = BrowserWindow.fromWebContents(contents)
  if (win && !win.isDestroyed()) win.destroy()
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

hardenApp()

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
      // PRIMARY selection (what's highlighted right now), read off the UI thread.
      void readPrimarySelection().then((text) => {
        if (!text.trim()) {
          showPalette()
          return
        }
        pendingRewriteText = text
        showPalette()
        sendToPalette('palette:shown', { mode: 'rewrite', rewriteText: text })
      })
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
    const logFile = initLogging()
    console.log(`[app] clipboard.md ${app.getVersion()} starting; logging to ${logFile}`)
    applyPermissionPolicy()
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

    // Keep the WAL from growing without bound in a long-lived process, and reclaim
    // space after retention deletes. Both are cheap and off the interactive path.
    setInterval(maintainDb, 30 * 60 * 1000)

    // Settings used to require a restart to take effect anywhere: push changes to
    // every window, and let the services that cached values re-read them.
    onSettingsChanged((s) => {
      broadcast('settings:changed', { settings: s })
      capture.applySettings()
      if (s.embeddings.enabled) startEmbeddings()
      else stopEmbeddings()
    })

    // Don't capture while the session is locked or asleep. This kills idle wakeups
    // and, more importantly, stops recording clips the user can't see happening.
    powerMonitor.on('suspend', () => {
      console.log('[power] suspending capture')
      capture.stop()
    })
    powerMonitor.on('resume', () => {
      // Let the compositor and X settle before re-attaching.
      setTimeout(() => {
        console.log('[power] resuming capture')
        capture.start()
      }, 5000)
    })
    powerMonitor.on('lock-screen', () => capture.stop())
    powerMonitor.on('unlock-screen', () => capture.start())

    // Stay resident so the hotkeys are instant instead of cold-starting Electron.
    if (!isAutostartEnabled()) setAutostart(true)

    routeArgsOnLaunch()
  })

  function routeArgsOnLaunch(): void {
    // Any known action flag routes; routeArgs itself defaults to toggle. (A hand-
    // maintained list here silently dropped --dictate on cold start.)
    if (process.argv.includes('--background')) return // autostart: no UI
    if (process.argv.some((a) => a.startsWith('--') && ACTION_FLAGS.includes(a))) {
      routeArgs(process.argv, actions)
    }
  }

  app.on('will-quit', () => {
    teardownHotkeys()
    flushSettings() // don't lose a debounced write on exit
    closeDb() // checkpoint + optimize + close, so nothing is stranded in the WAL
    closeLogging()
  })

  // Tray-less background app: closing windows must not quit.
  app.on('window-all-closed', () => {
    /* keep running */
  })
}
