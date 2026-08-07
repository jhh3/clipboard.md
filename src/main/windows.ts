import { BrowserWindow, screen, shell } from 'electron'
import { join } from 'path'

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
  // Center on the display the cursor is on. Under Xwayland the cursor point can be
  // stale when the pointer sits over a native-Wayland surface — display centering
  // degrades gracefully to the primary display in that case.
  try {
    const cursor = screen.getCursorScreenPoint()
    const display = screen.getDisplayNearestPoint(cursor)
    const { x, y, width, height } = display.workArea
    win.setPosition(
      Math.round(x + (width - PALETTE_W) / 2),
      Math.round(y + (height - PALETTE_H) / 3)
    )
  } catch {
    win.center()
  }
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
  const win = new BrowserWindow({
    width: w,
    height: h,
    show: false,
    autoHideMenuBar: true,
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
  win.once('ready-to-show', () => win.show())
  return win
}

export function openSettingsWindow(): void {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show()
    settingsWin.focus()
    return
  }
  settingsWin = createAuxWindow('settings', 820, 640)
}

export function openScratchpadWindow(itemId?: number): void {
  if (scratchWin && !scratchWin.isDestroyed()) {
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
