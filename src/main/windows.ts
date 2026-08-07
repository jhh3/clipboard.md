import { BrowserWindow, screen, shell } from 'electron'
import { join } from 'path'
import { getSettings, updateSettings } from './settings'

let palette: BrowserWindow | null = null

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

  palette.on('blur', () => hidePalette())

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
  // Always the primary display. Cursor-based placement is unreliable here: under
  // Xwayland getCursorScreenPoint() returns a stale point whenever the pointer is
  // over a Wayland-native surface, which lands the palette on the wrong monitor.
  const { x, y, width, height } = screen.getPrimaryDisplay().workArea
  win.setBounds({
    width: PALETTE_W,
    height: PALETTE_H,
    x: Math.round(x + (width - PALETTE_W) / 2),
    y: Math.round(y + (height - PALETTE_H) / 3)
  })
  // Re-assert stickiness on every show: mutter can otherwise "activate" the hidden
  // window on the workspace it last lived on, yanking the user to that desktop
  // instead of appearing on the current one.
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.show()
  win.focus()
  win.webContents.send('palette:shown', { collection })
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

/** Settings and scratchpad are normal opaque windows sharing the SPA via hash routes. */
let settingsWin: BrowserWindow | null = null
let scratchWin: BrowserWindow | null = null

function createAuxWindow(hash: string, w: number, h: number): BrowserWindow {
  // Never trust getCursorScreenPoint() here: under Xwayland it goes stale while the
  // pointer is over native-Wayland surfaces, which silently targets the wrong
  // monitor (observed: windows landing on the far-left display). Use the saved
  // position if we have one, else center on the PRIMARY display, always clamped
  // into that display's work area so the titlebar can't land off-screen.
  const saved = getSettings().windowBounds?.[hash]
  const primary = screen.getPrimaryDisplay().workArea
  let bounds: { x: number; y: number; width: number; height: number }
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
  const win = new BrowserWindow({
    ...bounds,
    show: false,
    autoHideMenuBar: true,
    // Frameless + our own titlebar. Rationale: with WM decorations, dragging goes
    // through the WM's interactive-move path, which on mutter uses
    // _NET_WM_SYNC_REQUEST — if the client doesn't acknowledge frames fast enough
    // the WM declares the app "Not Responding" about a second into the drag
    // (reproduced consistently). We move the window ourselves instead.
    frame: false,
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
  win.once('ready-to-show', () => {
    win.show()
    // Re-assert after map: some WMs place the window themselves on first show.
    win.setBounds(bounds)
  })

  // Persist geometry AFTER the gesture settles. 'moved'/'resized' fire continuously
  // while dragging on Linux; writing settings synchronously on each one blocks the
  // main process and the WM marks the app "Not Responding" mid-drag.
  let persistTimer: ReturnType<typeof setTimeout> | null = null
  const remember = (): void => {
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
