import { BrowserWindow, screen, shell } from 'electron'
import { join } from 'path'
import { getSettings, updateSettings } from './settings'

let palette: BrowserWindow | null = null
let lastPaletteShow = 0

// Content is 880x560; the extra 80px is transparent margin so the CSS drop
// shadow fades out fully instead of clipping hard at the window edge.
const PALETTE_W = 960
const PALETTE_H = 640

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
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  palette.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url)
    return { action: 'deny' }
  })

  // Summon must land on whatever workspace the user is on right now.
  palette.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  // Hide-on-blur, but never within the first moments of a show: on a cold start
  // (and on some WM focus hand-offs) the window blurs before it is ever really
  // focused, which would hide the palette the instant the hotkey summoned it.
  palette.on('blur', () => {
    if (Date.now() - lastPaletteShow < 500) return
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
  // On Wayland the compositor positions us (it centres popups sensibly). On X11,
  // centre on the primary display — cursor-based placement is unreliable there
  // because getCursorScreenPoint() goes stale over Wayland-native surfaces.
  if (!WAYLAND) {
    const { x, y, width, height } = screen.getPrimaryDisplay().workArea
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

/**
 * Under native Wayland the compositor owns window placement: setBounds x/y is a
 * no-op and getBounds reports nothing useful, so all our placement logic must sit
 * out. Mutter places and lets you drag these windows like any other app's.
 */
const WAYLAND = process.platform === 'linux' && process.env.XDG_SESSION_TYPE === 'wayland'

function createAuxWindow(hash: string, w: number, h: number): BrowserWindow {
  // On Wayland: size only — the compositor decides where windows go, and any x/y
  // we pass is either ignored or actively wrong. On X11/macOS: restore the saved
  // position, else centre on the primary display.
  let bounds: { x?: number; y?: number; width: number; height: number } = { width: w, height: h }
  if (!WAYLAND) {
    const saved = getSettings().windowBounds?.[hash]
    const primary = screen.getPrimaryDisplay().workArea
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
      sandbox: false
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

export function showDictationHud(): void {
  const W = 360
  const H = 132
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
      focusable: false, // never steal focus from the app you're dictating into
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
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
  const area = screen.getPrimaryDisplay().workArea
  win.setBounds({
    width: W,
    height: H,
    x: Math.round(area.x + (area.width - W) / 2),
    y: Math.round(area.y + area.height - H - 80)
  })
  win.showInactive()
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
  getDictationWindow()?.hide()
}

/**
 * Placement on re-show. If the user has never moved this window themselves (no saved
 * bounds), we own its position and always center it on the primary display — that's
 * predictable. Once they've moved it, we only intervene if it ends up off-screen.
 */
function ensureOnScreen(win: BrowserWindow, hash: string, w: number, h: number): void {
  if (WAYLAND) return // compositor-managed; our coordinates mean nothing here
  const userPlaced = !!getSettings().windowBounds?.[hash]
  const b = win.getBounds()
  const onScreen = screen.getAllDisplays().some((d) => isInside(b, d.workArea))
  if (userPlaced && onScreen) return
  const area = screen.getPrimaryDisplay().workArea
  win.setBounds({
    width: Math.min(w, area.width - 80),
    height: Math.min(h, area.height - 80),
    x: Math.round(area.x + (area.width - Math.min(w, area.width - 80)) / 2),
    y: Math.round(area.y + (area.height - Math.min(h, area.height - 80)) / 2)
  })
  console.log(`[win] ${hash} was off-screen; recentered`)
}

export function openSettingsWindow(): void {
  if (settingsWin && !settingsWin.isDestroyed()) {
    ensureOnScreen(settingsWin, 'settings', 820, 640)
    settingsWin.show()
    settingsWin.focus()
    return
  }
  settingsWin = createAuxWindow('settings', 820, 640)
}

export function openScratchpadWindow(itemId?: number): void {
  if (scratchWin && !scratchWin.isDestroyed()) {
    ensureOnScreen(scratchWin, 'scratchpad', 720, 560)
    scratchWin.show()
    scratchWin.focus()
    scratchWin.webContents.send('scratchpad:shown', { itemId })
    return
  }
  scratchWin = createAuxWindow('scratchpad', 720, 560)
  scratchWin.webContents.once('did-finish-load', () => {
    scratchWin?.webContents.send('scratchpad:shown', { itemId })
  })
}
