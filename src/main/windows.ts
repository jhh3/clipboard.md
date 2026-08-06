import { BrowserWindow, screen, shell } from 'electron'
import { join } from 'path'

let palette: BrowserWindow | null = null

const PALETTE_W = 880
const PALETTE_H = 560

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
