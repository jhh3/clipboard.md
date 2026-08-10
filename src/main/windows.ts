import { app, BrowserWindow, screen, shell } from 'electron'
import { join } from 'path'
import { getSettings, updateSettings } from './settings'

/**
 * Under native Wayland the compositor owns window placement: setBounds x/y is a
 * no-op and getBounds reports nothing useful, so all our placement logic must sit
 * out. Mutter places and lets you drag these windows like any other app's.
 */
const WAYLAND =
  process.platform === 'linux' &&
  process.env.XDG_SESSION_TYPE === 'wayland' &&
  // Only true when we are a NATIVE Wayland client. Under Xwayland (which we force
  // on GNOME/KDE so we can place the HUD) positioning works normally.
  app.commandLine.getSwitchValue('ozone-platform') !== 'x11'
const MACOS = process.platform === 'darwin'

/**
 * The display a summoned window should appear on.
 *
 * macOS: the one under the cursor. `getCursorScreenPoint()` is accurate there, and on
 * a multi-monitor desk the pointer is the best available proxy for "where the user is
 * looking" — a palette that always opens on the primary display is one that opens on
 * the wrong monitor most of the time.
 *
 * X11: the primary display. Cursor coordinates go stale over Wayland-native surfaces
 * under Xwayland, so the pointer is not trustworthy there, and a predictable location
 * beats an occasionally-wrong one. (Under real Wayland we don't place at all.)
 */
function activeDisplay(): Electron.Display {
  if (!MACOS) return screen.getPrimaryDisplay()
  try {
    return screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  } catch {
    return screen.getPrimaryDisplay()
  }
}

let palette: BrowserWindow | null = null
let lastPaletteShow = 0

// Content is 880x560. On Linux the window is 80px larger in each axis: that margin is
// transparent, so the CSS drop shadow can fade to zero alpha instead of clipping into
// a hard rectangle at the window edge.
//
// macOS needs no margin — AppKit draws a proper shadow around the window's rounded
// corners for us. Carrying the margin there produced two shadows: the CSS one, plus
// AppKit's around the full invisible frame, which read as a boxy halo floating well
// off the palette. Window is sized to the content and the native shadow is the only one.
const MAC_PALETTE = process.platform === 'darwin'
const PALETTE_W = MAC_PALETTE ? 880 : 960
const PALETTE_H = MAC_PALETTE ? 560 : 640

export function createPaletteWindow(): BrowserWindow {
  if (palette && !palette.isDestroyed()) return palette

  palette = new BrowserWindow({
    width: PALETTE_W,
    height: PALETTE_H,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    // A panel can take key focus without activating the application, which is what
    // makes the summon feel like Spotlight instead of an app launch: no Dock bounce,
    // and the app you were typing in stays "active" behind us so focus returns to it
    // cleanly when we hide. This is the Maccy behaviour.
    //
    // hasShadow/roundedCorners hand the palette's chrome to AppKit: the shadow follows
    // the rounded corners the way every other macOS panel's does, and the CSS shadow
    // switches off (styles.css, [data-platform='darwin']).
    ...(MACOS
      ? { type: 'panel' as const, hasShadow: true, roundedCorners: true }
      : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  palette.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url)
    return { action: 'deny' }
  })

  // Summon must land on whatever workspace the user is on right now. On macOS this
  // is what makes it follow you across Spaces instead of yanking you back to the one
  // it was first shown on.
  palette.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  // The default 'floating' level sits below a fullscreen app's window, so the palette
  // would be invisible over one no matter what visibleOnFullScreen says.
  if (MACOS) palette.setAlwaysOnTop(true, 'screen-saver')

  // Hide-on-blur, but never within the first moments of a show: on a cold start
  // (and on some WM focus hand-offs) the window blurs before it is ever really
  // focused, which would hide the palette the instant the hotkey summoned it.
  palette.on('blur', () => {
    if (Date.now() - lastPaletteShow < 500) return
    // Dictating INTO the palette must not dismiss it. Showing the HUD makes the
    // compositor blur the palette even though the HUD is focusable:false, so the
    // launcher vanished the moment the hotkey was pressed — and because the
    // "palette is open, route the transcript to the ask flow" branch in ipc.ts tests
    // isVisible(), it was always false by the time the transcript arrived, and the
    // words were pasted into whatever was behind instead.
    if (dictationActive) return
    hidePalette()
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    palette.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    palette.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return palette
}

export function getPalette(): BrowserWindow | null {
  return palette && !palette.isDestroyed() ? palette : null
}

export function showPalette(collection?: string): void {
  const win = createPaletteWindow()
  // On Wayland the compositor positions us (it centres popups sensibly). Elsewhere we
  // place it ourselves — see activeDisplay() for why the choice of display differs.
  if (!WAYLAND) {
    const { x, y, width, height } = activeDisplay().workArea
    win.setBounds({
      width: PALETTE_W,
      height: PALETTE_H,
      x: Math.round(x + (width - PALETTE_W) / 2),
      y: Math.round(y + (height - PALETTE_H) / 3)
    })
  }
  // Re-assert stickiness on every show: mutter can otherwise "activate" the hidden
  // window on the workspace it last lived on, yanking the user to that desktop
  // instead of appearing on the current one.
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  lastPaletteShow = Date.now()

  const reveal = (): void => {
    lastPaletteShow = Date.now()
    win.show()
    win.focus()
    win.moveTop()
    win.webContents.send('palette:shown', { collection })
  }
  // Cold start: the renderer may still be loading, and showing an empty window
  // that then blurs is how the hotkey ends up looking like it did nothing.
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', reveal)
  else reveal()
}

export function hidePalette(): void {
  const win = getPalette()
  if (win && win.isVisible()) win.hide()
}

export function togglePalette(): void {
  const win = getPalette()
  if (win && win.isVisible()) hidePalette()
  else showPalette()
}

export function sendToPalette(channel: string, payload: unknown): void {
  getPalette()?.webContents.send(channel, payload)
}

/** Broadcast to every open window (settings changes must reach all surfaces). */
export function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

/** Settings and scratchpad are normal opaque windows sharing the SPA via hash routes. */
let settingsWin: BrowserWindow | null = null
let scratchWin: BrowserWindow | null = null

function createAuxWindow(hash: string, w: number, h: number): BrowserWindow {
  // On Wayland: size only — the compositor decides where windows go, and any x/y
  // we pass is either ignored or actively wrong. On X11/macOS: restore the saved
  // position, else centre on the display the user is currently on.
  let bounds: { x?: number; y?: number; width: number; height: number } = { width: w, height: h }
  if (!WAYLAND) {
    const saved = getSettings().windowBounds?.[hash]
    const primary = activeDisplay().workArea
    if (saved && screen.getAllDisplays().some((d) => isInside(saved, d.workArea))) {
      bounds = saved
    } else {
      const width = Math.min(w, primary.width - 80)
      const height = Math.min(h, primary.height - 80)
      bounds = {
        width,
        height,
        x: Math.round(primary.x + (primary.width - width) / 2),
        y: Math.round(primary.y + (primary.height - height) / 2)
      }
    }
  }
  const win = new BrowserWindow({
    ...bounds,
    show: false,
    autoHideMenuBar: true,
    // Native decorations. The freeze during drags was never the frame: clipboard
    // reads on the UI thread (mutter's Wayland→X11 selection bridge) stalled the
    // frame/ping handshake. Those reads are now off-thread — see capture/clipboardIO.
    frame: true,
    movable: true,
    resizable: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(`${process.env.ELECTRON_RENDERER_URL}#${hash}`)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), { hash })
  }
  // Showing must not depend on 'ready-to-show': a hidden window has no Wayland
  // surface to paint into, so that event can never arrive and the window silently
  // never appears. 'did-finish-load' only needs the document, and a timer backstops
  // even that.
  let shown = false
  const revealOnce = (): void => {
    if (shown || win.isDestroyed()) return
    shown = true
    win.show()
    activateApp()
    win.focus()
    if (!WAYLAND && bounds.x !== undefined) win.setBounds(bounds as Electron.Rectangle)
  }
  win.once('ready-to-show', revealOnce)
  win.webContents.once('did-finish-load', revealOnce)
  setTimeout(revealOnce, 1500)

  // Persist geometry AFTER the gesture settles. 'moved'/'resized' fire continuously
  // while dragging on Linux; writing settings synchronously on each one blocks the
  // main process and the WM marks the app "Not Responding" mid-drag.
  let persistTimer: ReturnType<typeof setTimeout> | null = null
  const remember = (): void => {
    if (WAYLAND) return // nothing meaningful to persist; the compositor decides
    if (persistTimer) clearTimeout(persistTimer)
    persistTimer = setTimeout(() => {
      persistTimer = null
      if (win.isDestroyed() || win.isMinimized()) return
      updateSettings({ windowBounds: { ...getSettings().windowBounds, [hash]: win.getBounds() } })
    }, 800)
  }
  // 'moved'/'resized' are documented macOS/Windows-only; 'move'/'resize' are what
  // actually fire on Linux. Both are wired, and the debounce keeps the frequent
  // ones cheap (a write per event is what blocked the main process before).
  win.on('move', remember)
  win.on('resize', remember)
  win.on('moved', remember)
  win.on('resized', remember)
  win.on('closed', () => {
    if (persistTimer) clearTimeout(persistTimer)
  })
  return win
}

function isInside(
  b: { x: number; y: number; width: number; height: number },
  area: { x: number; y: number; width: number; height: number }
): boolean {
  // Titlebar must be reachable: require the top-left to sit inside a work area.
  return b.x >= area.x - 8 && b.y >= area.y - 8 && b.x < area.x + area.width - 100 && b.y < area.y + area.height - 40
}

/**
 * Dictation HUD: a small always-on-top overlay that starts recording the moment it
 * appears and stops when the hotkey is released (or Esc / a second press).
 * Kept alive hidden between uses so mic permission and warm-up cost are paid once.
 */
let dictationWin: BrowserWindow | null = null

export function getDictationWindow(): BrowserWindow | null {
  return dictationWin && !dictationWin.isDestroyed() ? dictationWin : null
}

/**
 * True from the moment the HUD is shown until it is hidden again. Read by the
 * palette's blur handler so a dictation started from the launcher keeps it open.
 */
let dictationActive = false

export function showDictationHud(): void {
  dictationActive = true
  // Deliberately small: on Wayland the compositor decides where this lands (our
  // setBounds x/y is a no-op), so it will be centred no matter what we ask for.
  // A compact pill is far less obtrusive there than a panel, and the bottom
  // placement below still applies on X11 and macOS.
  const W = 300
  const H = 96
  if (!getDictationWindow()) {
    dictationWin = new BrowserWindow({
      width: W,
      height: H,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      // Never take focus. Key-up now comes from evdev (see ptt.ts), so the HUD has
      // no reason to hold the keyboard — and when it did, the Ctrl+V we injected
      // after transcribing landed in the HUD instead of the app being dictated
      // into, which is why it reported "Pasted" while nothing was pasted.
      focusable: false,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })
    if (process.env.ELECTRON_RENDERER_URL) {
      dictationWin.loadURL(`${process.env.ELECTRON_RENDERER_URL}#dictation`)
    } else {
      dictationWin.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'dictation' })
    }
  }
  const win = dictationWin!
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  // Same reasoning as the palette: the HUD belongs where the user is working, and it
  // must float over a fullscreen app rather than behind it.
  if (MACOS) win.setAlwaysOnTop(true, 'screen-saver')
  const area = activeDisplay().workArea
  win.setBounds({
    width: W,
    height: H,
    x: Math.round(area.x + (area.width - W) / 2),
    // Bottom-centre, above where a dock/dash usually sits (honoured off Wayland).
    y: Math.round(area.y + area.height - H - 120)
  })
  win.showInactive() // must not steal focus from the app being dictated into
  // On the first invocation the renderer hasn't subscribed yet — a send here would
  // be dropped and the first hotkey press would silently do nothing.
  if (win.webContents.isLoading()) {
    win.webContents.once('did-finish-load', () => win.webContents.send('dictation:start', {}))
  } else {
    win.webContents.send('dictation:start', {})
  }
}

export function stopDictation(): void {
  getDictationWindow()?.webContents.send('dictation:stop', {})
}

export function hideDictationHud(): void {
  dictationActive = false
  getDictationWindow()?.hide()
  // The palette was held open through the dictation by the blur guard above. If focus
  // never came back to it, it would now be a stuck, unfocused window the user has to
  // dismiss by hand — so re-focus it and let the normal blur rule apply again.
  const pal = getPalette()
  if (pal && !pal.isDestroyed() && pal.isVisible()) pal.focus()
}

/**
 * Placement on re-show. If the user has never moved this window themselves (no saved
 * bounds), we own its position and always centre it — that's predictable. Once they
 * have moved it, we only intervene if it ends up off-screen, which is what happens
 * when the display it was saved on gets unplugged.
 */
function ensureOnScreen(win: BrowserWindow, hash: string, w: number, h: number): void {
  if (WAYLAND) return // compositor-managed; our coordinates mean nothing here
  const userPlaced = !!getSettings().windowBounds?.[hash]
  const b = win.getBounds()
  const onScreen = screen.getAllDisplays().some((d) => isInside(b, d.workArea))
  if (userPlaced && onScreen) return
  const area = activeDisplay().workArea
  win.setBounds({
    width: Math.min(w, area.width - 80),
    height: Math.min(h, area.height - 80),
    x: Math.round(area.x + (area.width - Math.min(w, area.width - 80)) / 2),
    y: Math.round(area.y + (area.height - Math.min(h, area.height - 80)) / 2)
  })
  console.log(`[win] ${hash} was off-screen; recentered`)
}

/**
 * Bring the app forward for a real window.
 *
 * The Dock icon is hidden (see index.ts), which makes us an accessory app — and an
 * accessory app's windows can be raised without the app ever becoming active, so a
 * settings window would open behind whatever you were using and not take keystrokes.
 * The palette deliberately does NOT do this: it is a panel precisely so it can take
 * keys without stealing activation from the app you are pasting into.
 */
function activateApp(): void {
  if (MACOS) app.focus({ steal: true })
}

export function openSettingsWindow(): void {
  if (settingsWin && !settingsWin.isDestroyed()) {
    ensureOnScreen(settingsWin, 'settings', 820, 640)
    settingsWin.show()
    activateApp()
    settingsWin.focus()
    return
  }
  settingsWin = createAuxWindow('settings', 820, 640)
}

let notesWin: BrowserWindow | null = null

/**
 * The notes window. Larger than the other aux windows because it is three panes
 * (list, editor, links) and is meant to be worked in rather than dismissed.
 */
export function openNotesWindow(noteId?: number): void {
  const send = (): void => notesWin?.webContents.send('notes:open', { id: noteId })
  if (notesWin && !notesWin.isDestroyed()) {
    ensureOnScreen(notesWin, 'notes', 1080, 720)
    notesWin.show()
    activateApp()
    notesWin.focus()
    send()
    return
  }
  notesWin = createAuxWindow('notes', 1080, 720)
  notesWin.webContents.once('did-finish-load', send)
}

let agentsWin: BrowserWindow | null = null

/** Agent sessions and their inbox. */
export function openAgentsWindow(): void {
  if (agentsWin && !agentsWin.isDestroyed()) {
    ensureOnScreen(agentsWin, 'agents', 980, 700)
    agentsWin.show()
    activateApp()
    agentsWin.focus()
    return
  }
  agentsWin = createAuxWindow('agents', 980, 700)
}

export function openScratchpadWindow(itemId?: number): void {
  if (scratchWin && !scratchWin.isDestroyed()) {
    ensureOnScreen(scratchWin, 'scratchpad', 720, 560)
    scratchWin.show()
    activateApp()
    scratchWin.focus()
    scratchWin.webContents.send('scratchpad:shown', { itemId })
    return
  }
  scratchWin = createAuxWindow('scratchpad', 720, 560)
  scratchWin.webContents.once('did-finish-load', () => {
    scratchWin?.webContents.send('scratchpad:shown', { itemId })
  })
}
