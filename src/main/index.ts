import { app, powerMonitor, BrowserWindow, Notification } from 'electron'
import { readPrimarySelection } from './capture/clipboardIO'
import { isAutostartEnabled, autostartIsStale, setAutostart } from './autostart'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { existsSync, writeFileSync } from 'fs'
import { openDb, closeDb, maintainDb } from './store/db'
import { applyRetention } from './store/items'
import { CaptureService } from './capture'
import { PasteService } from './paste'
import { registerIpc } from './ipc'
import { noteDictationTarget } from './focusedWindow'
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
import {
  setupHotkeys,
  routeArgs,
  teardownHotkeys,
  keyRepeatTiming,
  ACTION_FLAGS,
  type HotkeyActions
} from './hotkeys'
import { getSettings, flushSettings, onSettingsChanged } from './settings'
import { startEnrichment, drain as drainEnrichment, assignSession } from './enrichment'
import { startEmbeddings, stopEmbeddings } from './embeddings'
import { setAiTransform } from './transforms'
import { complete } from './modelport'
import { takeScreenshot } from './screenshot'
import { createTray, buildTrayMenu, destroyTray } from './tray'
import { unreadCount, prewarmAgents } from './agents'
import { ensureMemoryFile, startMemorySchedule } from './assistantMemory'
import { sweep } from './agentLifecycle'
import { ensurePlugin, ensureMcpServer } from './agentPlugin'
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
  // Software rendering cannot drive Xwayland here. With the GPU disabled, Chromium
  // presents X11 windows through x11_software_bitmap_presenter, which fails on this
  // setup ("XGetWindowAttributes failed for window N") and NO window is ever mapped —
  // the app runs, the tray works, and nothing can be opened. Native Wayland renders
  // fine in the same state, so when the GPU is out we take Wayland and accept that
  // the compositor, not us, places the dictation HUD.
  //
  // Note this only reads the flag; DISPLAY stays set either way, which matters
  // because clipboard I/O is X11-based (xclip, XFixes) regardless of the UI backend.
  if (existsSync(gpuFallbackFlag())) return 'auto'
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

/**
 * Serve MCP over stdio from this process.
 *
 * stdout IS the transport, so anything else printed there corrupts the JSON-RPC
 * framing and the agent drops the server with an unhelpful "connection closed".
 * Chromium and our own logger both write to stdout, so console is redirected to
 * stderr for the lifetime of this mode — stderr is free, and the agent shows it.
 *
 * The server is loaded from the sibling bundle by a computed path so it stays a
 * separate entry (electron.vite.config) instead of being pulled into this one.
 */
async function startStdioServer(bundle: string): Promise<void> {
  const toStderr = (...args: unknown[]): void => {
    process.stderr.write(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ') + '\n')
  }
  console.log = toStderr
  console.info = toStderr
  console.warn = toStderr
  console.error = toStderr
  try {
    const entry = pathToFileURL(join(__dirname, bundle)).href
    await import(/* @vite-ignore */ entry)
  } catch (err) {
    process.stderr.write(`[stdio] ${bundle} failed to start: ${String(err)}\n`)
    app.exit(1)
  }
}

/**
 * `--mcp` turns this same binary into the stdio MCP server, so agents can search the
 * clipboard without a separate install.
 *
 * It has to be the app's own binary rather than a script path. Registration is
 * permanent (it lives in the agent's config) but every script path we could register
 * is not: inside an AppImage everything sits in an ephemeral /tmp/.mount_XXXX that is
 * gone the moment the app restarts, and a dev checkout's path changes with the pnpm
 * store. The installed binary is the one stable, always-present address, so the flag
 * lives here.
 *
 * The single-instance lock is skipped: this is a short-lived child of the agent, not
 * a second copy of the app, and taking the lock would make it fight the running one.
 */
const MCP_MODE = process.argv.includes('--mcp')
// --bridge is the per-session channel server (see agentPlugin), registered against
// this binary for the same reason --mcp is: the path outlives the process.
const BRIDGE_MODE = process.argv.includes('--bridge')
const gotLock = MCP_MODE || BRIDGE_MODE || app.requestSingleInstanceLock()
if (MCP_MODE || BRIDGE_MODE) {
  void startStdioServer(MCP_MODE ? 'mcp.mjs' : 'bridge.mjs')
} else if (!gotLock) {
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

  // Both ends are logged because dictation has several ways to fail silently — the
  // chord never matching, the HUD never appearing, the recording never stopping —
  // and they are indistinguishable from the outside. One line each turns "it does
  // nothing" into a specific answer.
  /**
   * Whether the CURRENT recording should get the AI pass. Captured at start, because
   * the transcript arrives long after the key that chose the mode was released.
   */
  let dictateEnhance = false

  const beginDictation = (enhance = false): void => {
    if (dictating) return
    dictating = true
    dictateEnhance = enhance
    dictateStartedAt = Date.now()
    console.log('[dictate] start')
    noteDictationTarget()
    showDictationHud()
  }

  const endDictation = (): void => {
    if (!dictating) return
    dictating = false
    clearHoldTimer()
    lastStopAt = Date.now()
    console.log(`[dictate] stop after ${lastStopAt - dictateStartedAt}ms`)
    stopDictation()
  }

  const pttHandlers = {
    onPress: () => beginDictation(),
    onRelease: () => {
      // A quick tap latches recording on; a genuine hold ends on release.
      if (Date.now() - dictateStartedAt < MIN_HOLD_MS) return
      endDictation()
    }
  }

  /**
   * Hotkey path. ALWAYS live, even when evdev is watching.
   *
   * This used to `return` whenever pttActive was true, handing dictation entirely to
   * evdev. That makes evdev a single point of failure: if the chord never matches —
   * wrong keycodes for the keyboard, a device that appears after enumeration, a read
   * that silently delivers nothing — dictation is not degraded, it is *gone*, and the
   * hotkey that would still have worked was switched off to make room for it.
   *
   * So the two now cooperate instead of one excluding the other. The hotkey starts
   * dictation; evdev's release stops it the instant it arrives (true hold-to-talk).
   * With no evdev, the hotkey alone toggles. Dictation is reachable either way.
   */
  const RESTART_GUARD_MS = 400
  /** Slack added to a repeat deadline, to absorb scheduling jitter. */
  const REPEAT_SLACK_MS = 250
  let lastHotkeyAt = 0
  let lastStopAt = 0
  let holdTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * unknown → pressed, but we have not yet learned whether it is a tap or a hold.
   * holding → key repeats are arriving, so the chord is still down.
   * latched → it was a tap; recording stays on until the chord is pressed again.
   */
  let holdMode: 'unknown' | 'holding' | 'latched' = 'unknown'
  /** Read from the desktop at startup; see hotkeys.keyRepeatTiming. */
  let repeat = { delay: 500, interval: 30, enabled: true }

  const clearHoldTimer = (): void => {
    if (holdTimer) clearTimeout(holdTimer)
    holdTimer = null
  }

  const armHoldTimer = (ms: number): void => {
    clearHoldTimer()
    holdTimer = setTimeout(() => {
      holdTimer = null
      if (holdMode === 'holding') {
        // Repeats stopped arriving: the chord was released.
        endDictation()
      } else {
        // Never saw a repeat, so it was a tap, not a hold. Latch recording on rather
        // than cutting it off — a tap is how you dictate something long without
        // holding a chord down for a minute.
        holdMode = 'latched'
        console.log('[dictate] tap detected; latched on until the chord is pressed again')
      }
    }, ms)
  }

  /**
   * Hotkey path. ALWAYS live, even when evdev is watching.
   *
   * Release detection here comes from GNOME's key REPEAT, because a custom
   * keybinding only ever delivers key-down. While the chord is held GNOME re-runs the
   * command every `repeat.interval` ms after an initial `repeat.delay`; when the
   * repeats stop, the key is up. Those timings are read from the desktop rather than
   * assumed — hardcoding them is exactly why the previous attempt failed.
   *
   * evdev, when it works, still wins: its release fires endDictation immediately and
   * cancels this timer. This is the fallback that makes dictation work anyway.
   */
  const dictateTrigger = (enhance = false): void => {
    const now = Date.now()
    const sinceLast = now - lastHotkeyAt
    lastHotkeyAt = now

    if (!dictating) {
      // A trailing key-repeat can land just after we stopped on release; without this
      // it would immediately start a second recording.
      if (now - lastStopAt < RESTART_GUARD_MS) return
      holdMode = 'unknown'
      beginDictation(enhance)
      // No repeat can arrive before `delay`, so anything sooner means a tap.
      if (repeat.enabled) armHoldTimer(repeat.delay + REPEAT_SLACK_MS)
      return
    }

    // Already recording. A gap no larger than the repeat delay means this is the same
    // hold continuing; anything longer is a deliberate second press.
    const isRepeat = repeat.enabled && sinceLast <= repeat.delay + REPEAT_SLACK_MS
    if (isRepeat) {
      holdMode = 'holding'
      // Now that repeats are flowing they arrive every `interval` ms, so the deadline
      // can tighten — that is what keeps the stop responsive after release.
      armHoldTimer(repeat.interval + REPEAT_SLACK_MS)
      return
    }
    clearHoldTimer()
    endDictation()
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
    // Same recording flow; only the post-processing differs.
    dictateEnhance: () => dictateTrigger(true),
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
    // Hide EVERY surface of ours before a paste is injected, not just the palette.
    //
    // The injected Ctrl+V goes to whatever the compositor considers focused. Passing
    // only hidePalette left the dictation HUD on screen — it is still showing the
    // transcript when the keystroke fires — so dictation "pasted" into the HUD and
    // the user saw the text reach the clipboard and nowhere else. The portal even
    // reported success, because injection genuinely happened; it just landed on us.
    //
    // This is the same failure the palette had (a focusable window eating its own
    // paste). focusable:false plus showInactive() fixed it under Xwayland, but those
    // are hints a Wayland compositor is free to ignore, so the reliable answer is to
    // not be on screen at all when the key is sent.
    const paste = new PasteService(capture, () => {
      hidePalette()
      hideDictationHud()
    })

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
      // Which key started this recording, read when its transcript comes back.
      isEnhanced: () => dictateEnhance,
      onDictationDone: () => {
        dictating = false
        dictateEnhance = false
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
    pttActive = startPushToTalk(pttHandlers)
    // Read the desktop's repeat timing before the first hotkey can arrive: it is what
    // turns key-down-only triggers into a usable hold signal.
    repeat = await keyRepeatTiming()
    console.log(
      `[dictate] evdev=${pttActive ? 'on' : 'off'}; key-repeat hold signal ` +
        (repeat.enabled
          ? `delay=${repeat.delay}ms interval=${repeat.interval}ms`
          : 'DISABLED in the desktop settings — the chord will toggle instead of hold')
    )

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
    let lastChord = getSettings().dictateChord
    onSettingsChanged((s) => {
      broadcast('settings:changed', { settings: s })
      buildTrayMenu() // the Pause-capture checkbox must reflect changes made in Settings
      capture.applySettings()
      if (s.embeddings.enabled) startEmbeddings()
      else stopEmbeddings()
      // A new dictation chord has to reach BOTH halves or it half-applies: evdev is
      // re-armed here, and the GNOME keybinding is rewritten by setupHotkeys (that
      // binding is derived from the same setting — see hotkeys.ts). Linux only;
      // macOS dictation is the Fn key via the helper and ignores this entirely.
      if (process.platform === 'linux' && s.dictateChord !== lastChord) {
        lastChord = s.dictateChord
        pttActive = startPushToTalk(pttHandlers)
        void setupHotkeys(actions)
        console.log(`[dictate] chord changed to ${s.dictateChord}`)
      }
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
    // Rewrite a stale entry too, not just a missing one — see autostartIsStale.
    if (app.isPackaged && (!isAutostartEnabled() || autostartIsStale())) setAutostart(true)

    // Sessions outlive the app and die behind its back. The sweep adopts orphans,
    // buries dead rows, sleeps idle sessions and tears down what is never coming
    // back — see agentLifecycle.ts. A stale "running" row is worse than none: the
    // user sends a clip into it and nothing happens, silently.
    void ensurePlugin()
    // One install should also give the user's agents clipboard search.
    void ensureMcpServer()
    void sweep()
    setInterval(() => void sweep(), 5 * 60_000)

    // The assistant: memory file + consolidation schedule, and a pre-warmed
    // session so the palette's first ask answers in seconds, not a cold start.
    // Delayed so startup (capture, embeddings, plugin install) wins the CPU first.
    ensureMemoryFile()
    startMemorySchedule()
    setTimeout(() => void prewarmAgents(), 8000)

    createTray()

    // Agents write to the inbox from OUTSIDE this process (the bridge and the Stop
    // hook insert into SQLite directly), so no IPC event fires when a reply lands.
    // Poll the unread count and surface changes: the tray badge is the only signal
    // a blocked agent has, and without this it stayed stale until a settings change.
    let lastUnread = -1
    setInterval(() => {
      try {
        const n = unreadCount()
        if (n === lastUnread) return
        lastUnread = n
        buildTrayMenu()
        broadcast('agents:changed', { unread: n })
      } catch {
        /* db closing during quit */
      }
    }, 10_000)

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
