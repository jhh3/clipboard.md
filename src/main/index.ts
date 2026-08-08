import { app, powerMonitor, BrowserWindow, Notification } from 'electron'
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
  openNotesWindow,
  openAgentsWindow,
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
import { takeScreenshot } from './screenshot'
import { createTray, buildTrayMenu, destroyTray } from './tray'
import { sweep } from './agentLifecycle'
import { ensurePlugin } from './agentPlugin'
import { macSelectedText, isTrusted, helperAvailable } from './mac/helper'
import { hardenApp, applyPermissionPolicy } from './security'
import { initLogging, closeLogging } from './log'
import { startDbusService } from './dbusService'
import { startPushToTalk, stopPushToTalk } from './ptt'

const gpuFallbackFlag = (): string => join(app.getPath('userData'), 'force-software-gpu')

if (process.platform === 'linux') {
  // Backend choice per compositor.
  //
  // Native Wayland refuses to let a client position its own windows, so the
  // recording HUD lands wherever mutter wants it — dead centre, over whatever the
  // user is doing. Under Xwayland we can place it ourselves. This is the same
  // trade VibeTyper makes (its tests read "keeps native Wayland on wlroots-style
  // compositors", forcing x11 elsewhere): wlroots compositors handle this well,
  // GNOME and KDE do not.
  //
  // The reasons we originally moved OFF Xwayland — the desktop freeze, unmovable
  // windows, wrong-monitor placement — were separately root-caused and fixed
  // (clipboard ownership and UI-thread reads), so the trade is now worth taking.
  // Use the direct switch, not --ozone-platform-hint: the hint is advisory and was
  // observed resolving back to wayland on this system. (VibeTyper passes
  // --ozone-platform=x11 for the same reason.)
  const ozone = preferredOzonePlatform()
  if (ozone === 'x11') app.commandLine.appendSwitch('ozone-platform', 'x11')
  else app.commandLine.appendSwitch('ozone-platform-hint', 'auto')
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

/**
 * 'x11' on compositors that won't let us place windows (GNOME, KDE); 'auto' —
 * i.e. native Wayland — on wlroots-style compositors and X11 sessions, where
 * either positioning works or the compositor does the right thing anyway.
 */
function preferredOzonePlatform(): string {
  if (process.env.XDG_SESSION_TYPE !== 'wayland') return 'auto'
  const desktop = `${process.env.XDG_CURRENT_DESKTOP ?? ''}:${process.env.XDG_SESSION_DESKTOP ?? ''}`
  const wlroots = /sway|hyprland|river|wayfire|labwc|niri/i.test(desktop) || !!process.env.HYPRLAND_INSTANCE_SIGNATURE
  if (wlroots) return 'auto'
  // No Xwayland to fall back to: native Wayland is the only option.
  if (!process.env.DISPLAY) return 'auto'
  return 'x11'
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

  /**
   * Dictation state. Hold-to-talk is driven by evdev (ptt.ts) when a keyboard
   * device is readable; otherwise the hotkey acts as a plain toggle.
   */
  let dictating = false
  /** True when evdev is driving hold-to-talk, so the hotkey must not also toggle. */
  let pttActive = false
  /** Ignore a release that arrives implausibly fast (a tap, not a hold). */
  let dictateStartedAt = 0
  const MIN_HOLD_MS = 250

  const beginDictation = (): void => {
    if (dictating) return
    dictating = true
    dictateStartedAt = Date.now()
    showDictationHud()
  }

  const endDictation = (): void => {
    if (!dictating) return
    dictating = false
    stopDictation()
  }

  /** Hotkey path — only used when evdev hold-to-talk isn't available. */
  const dictateTrigger = (): void => {
    if (pttActive) return // evdev owns start/stop; ignore key-repeat noise
    if (dictating) endDictation()
    else beginDictation()
  }

  /**
   * What the user has highlighted right now, for the rewrite hotkey.
   *
   * Linux reads the PRIMARY selection (off the UI thread). macOS has no PRIMARY, so
   * the fallback there was `clipboard.readText()` — which quietly rewrites whatever
   * was last *copied* instead of what is *selected*. The helper's AX chain reads the
   * real selection; if it can't, we return empty and the palette opens normally
   * rather than acting on the wrong text.
   */
  /**
   * Ask for Accessibility once, at launch, on macOS.
   *
   * Nothing called the trust check before, so a fresh install was never added to the
   * Accessibility list and was never prompted to be. Paste and rewrite then failed
   * silently forever — the exact symptom of "Enter does nothing", with nothing in the
   * log to explain it, because both features degrade quietly by design.
   *
   * The prompt is what registers us in System Settings, so it has to happen even
   * though macOS only shows the dialog once per binary. Firing it from the helper (a
   * child process) is deliberate: TCC attributes the request to the responsible
   * process, which is the app bundle, so the grant lands on clipboard.md.app rather
   * than on the helper.
   */
  async function ensureAccessibility(): Promise<void> {
    if (!helperAvailable()) return
    if (await isTrusted()) {
      console.log('[mac] Accessibility granted; paste injection and selection capture are live')
      return
    }
    console.error(
      '[mac] Accessibility NOT granted — paste will fall back to "press ⌘V" and the ' +
        'rewrite hotkey cannot read your selection. Requesting it now.'
    )
    await isTrusted(true)
    new Notification({
      title: 'clipboard.md needs Accessibility',
      body: 'Allow clipboard.md under Privacy & Security ▸ Accessibility, then restart it, to paste automatically and rewrite selected text.'
    }).show()
  }

  async function currentSelection(): Promise<string> {
    if (process.platform !== 'darwin') return readPrimarySelection()
    const { text, untrusted } = await macSelectedText()
    if (untrusted) {
      new Notification({
        title: 'clipboard.md needs Accessibility',
        body: 'Allow clipboard.md under Privacy & Security ▸ Accessibility to rewrite selected text.',
        silent: true
      }).show()
      return ''
    }
    return text ?? ''
  }

  const actions: HotkeyActions = {
    toggle: () => togglePalette(),
    rewrite: () => {
      void currentSelection().then((text) => {
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
        const path = await takeScreenshot()
        if (path) capture.ingestImageFile(path)
      })()
    },
    scratchpad: () => openScratchpadWindow(),
    dictate: () => dictateTrigger(),
    notes: () => openNotesWindow(),
    agents: () => openAgentsWindow()
  }

  app.on('second-instance', (_e, argv) => {
    routeArgs(argv, actions)
  })

  app.whenReady().then(async () => {
    const logFile = initLogging()
    console.log(`[app] clipboard.md ${app.getVersion()} starting; logging to ${logFile}`)
    applyPermissionPolicy()
    // No Dock icon and no ⌘-Tab entry: this is a background app summoned by a hotkey,
    // and a Dock bounce on every launch is exactly the "it feels like an app" texture
    // Maccy avoids. Windows that genuinely need activation call app.focus() instead.
    if (process.platform === 'darwin') app.dock?.hide()
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
    // Hotkeys talk to us over D-Bus so a held key doesn't cold-start Electron.
    if (process.platform === 'linux') {
      await startDbusService((action) => routeArgs([`--${action}`], actions))
    }
    // Real hold-to-talk from key up/down: evdev on Linux, a listen-only event tap via
    // the helper on macOS. Neither platform's global-hotkey API can express a release
    // — GNOME keybindings and Electron's globalShortcut both only ever fire on
    // key-down — so this is the only way to get honest push-to-talk on either.
    pttActive = startPushToTalk({
      onPress: () => beginDictation(),
      onRelease: () => {
        // A quick tap latches recording on; a genuine hold ends on release.
        if (Date.now() - dictateStartedAt < MIN_HOLD_MS) return
        endDictation()
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
      buildTrayMenu() // the Pause-capture checkbox must reflect changes made in Settings
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

    if (process.platform === 'darwin') void ensureAccessibility()

    // Stay resident so the hotkeys are instant instead of cold-starting Electron.
    // Only from a packaged build: in dev this would register the Electron binary
    // inside node_modules as a login item on the developer's machine, which then
    // fails at every login once the checkout moves or the dep is reinstalled.
    if (app.isPackaged && !isAutostartEnabled()) setAutostart(true)

    // Sessions outlive the app and die behind its back. The sweep adopts orphans,
    // buries dead rows, sleeps idle sessions and tears down what is never coming
    // back — see agentLifecycle.ts. A stale "running" row is worse than none: the
    // user sends a clip into it and nothing happens, silently.
    void ensurePlugin()
    void sweep()
    setInterval(() => void sweep(), 5 * 60_000)

    void createTray()

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
    destroyTray()
    teardownHotkeys()
    stopPushToTalk()
    flushSettings() // don't lose a debounced write on exit
    closeDb() // checkpoint + optimize + close, so nothing is stranded in the WAL
    closeLogging()
  })

  // Tray-less background app: closing windows must not quit.
  app.on('window-all-closed', () => {
    /* keep running */
  })
}
