import { BrowserWindow, desktopCapturer, screen } from 'electron'
import { join } from 'path'

/**
 * Region capture on Windows, built from parts we already ship.
 *
 * Two routes were REJECTED before this one, and it is worth saying why:
 *
 *  - `explorer ms-screenclip:` is the system snip UI, and it puts the result on the
 *    CLIPBOARD. It gives no completion signal and no path, so we would have to watch
 *    the clipboard for an image and hope — and our own capture loop would race us to
 *    ingest that image as an ordinary clip. One user action, two history entries,
 *    and no way to tell which one the user meant.
 *  - `SnippingTool.exe /clip` is removed or redirected on Windows 11.
 *
 * So: grab the screen with desktopCapturer, show the grab full-screen as an OPAQUE
 * window, let the user drag on it, and crop with sharp. Opaque and not transparent
 * on purpose — a transparent frameless window under software rendering paints solid
 * black on Windows (see windows.ts), and this overlay must work in exactly the
 * degraded state the app falls back to after a GPU crash.
 *
 * The result is a PNG path, which is the contract takeScreenshot() already has, so
 * capture.ingestImageFile stays unchanged and Esc still yields null.
 */

export interface Selection {
  /** CSS pixels, relative to the overlay window's own top-left. */
  x: number
  y: number
  width: number
  height: number
}

export interface CropRect {
  left: number
  top: number
  width: number
  height: number
}

/**
 * Selection in CSS pixels → extract rectangle in SOURCE pixels.
 *
 * The two differ by the display's scale factor, and on a mixed-DPI desk they differ
 * by a DIFFERENT factor per monitor: a 150% laptop panel beside a 100% external is
 * the ordinary Windows setup, not an edge case. Getting this wrong does not error —
 * it crops the wrong part of the picture, which reads as "the screenshot tool is
 * off by a bit" and is nearly impossible to attribute.
 *
 * Clamped to the source bounds because a drag that leaves the window reports
 * coordinates outside it, and sharp throws "extract_area: bad extract area" for a
 * rect that overhangs by one pixel.
 */
export function cropRect(sel: Selection, scaleFactor: number, source: { width: number; height: number }): CropRect | null {
  const left = Math.round(Math.min(sel.x, sel.x + sel.width) * scaleFactor)
  const top = Math.round(Math.min(sel.y, sel.y + sel.height) * scaleFactor)
  const right = Math.round(Math.max(sel.x, sel.x + sel.width) * scaleFactor)
  const bottom = Math.round(Math.max(sel.y, sel.y + sel.height) * scaleFactor)

  const l = clamp(left, 0, source.width)
  const t = clamp(top, 0, source.height)
  const w = clamp(right, 0, source.width) - l
  const h = clamp(bottom, 0, source.height) - t
  // A click without a drag is a cancel, not a 0x0 crop. sharp would throw on that,
  // and a 1px image in the history is worse than nothing.
  if (w < 2 || h < 2) return null
  return { left: l, top: t, width: w, height: h }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

/**
 * Match a desktopCapturer source to a display.
 *
 * `display_id` is a string on the source and a number on the Display, and it is
 * EMPTY on some drivers — in which case index order is the only thing left. Falling
 * back matters on a single-monitor machine, which is most of them; failing to match
 * there would mean no capture at all rather than a possibly-wrong monitor.
 */
export function matchSource<T extends { display_id?: string; id: string }>(
  sources: T[],
  display: { id: number },
  index: number
): T | undefined {
  const byId = sources.find((s) => s.display_id === String(display.id))
  if (byId) return byId
  return sources[index]
}

interface Grab {
  display: Electron.Display
  png: Buffer
  dataUrl: string
}

async function grabScreens(): Promise<Grab[]> {
  const displays = screen.getAllDisplays()
  // Thumbnails at full source resolution: this is a screenshot, not a thumbnail, and
  // the default 150x150 would return a postage stamp with no error.
  const largest = displays.reduce(
    (a, d) => ({
      width: Math.max(a.width, Math.round(d.size.width * d.scaleFactor)),
      height: Math.max(a.height, Math.round(d.size.height * d.scaleFactor))
    }),
    { width: 0, height: 0 }
  )
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: largest })
  const out: Grab[] = []
  displays.forEach((display, i) => {
    const source = matchSource(sources, display, i)
    if (!source || source.thumbnail.isEmpty()) return
    out.push({ display, png: source.thumbnail.toPNG(), dataUrl: source.thumbnail.toDataURL() })
  })
  return out
}

/**
 * Run the overlay and return the crop, or null if the user cancelled.
 *
 * `outPath` is written only on a real selection, because takeScreenshot's callers
 * distinguish "a file exists" from "cancelled" — see screenshot.ts.
 */
export async function captureRegion(outPath: string): Promise<string | null> {
  const grabs = await grabScreens()
  if (grabs.length === 0) {
    console.error('[screenshot] desktopCapturer returned no screens')
    return null
  }

  const windows: BrowserWindow[] = []
  const closeAll = (): void => {
    for (const w of windows) if (!w.isDestroyed()) w.destroy()
  }

  const picked = await new Promise<{ grab: Grab; sel: Selection } | null>((resolve) => {
    let settled = false
    const finish = (value: { grab: Grab; sel: Selection } | null): void => {
      if (settled) return
      settled = true
      resolve(value)
    }

    for (const grab of grabs) {
      const { x, y, width, height } = grab.display.bounds
      const win = new BrowserWindow({
        x,
        y,
        width,
        height,
        frame: false,
        // Opaque, showing the captured image. See the note at the top of this file.
        transparent: false,
        resizable: false,
        movable: false,
        minimizable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        fullscreenable: false,
        webPreferences: {
          preload: join(__dirname, '../preload/index.js'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true
        }
      })
      windows.push(win)
      win.setAlwaysOnTop(true, 'screen-saver')
      // Closing any overlay (Esc, alt-F4, a crash) must end the whole gesture, or the
      // other monitors keep a full-screen window the user cannot get rid of.
      win.on('closed', () => finish(null))

      const send = (): void => {
        win.webContents.send('region:begin', {
          image: grab.dataUrl,
          scaleFactor: grab.display.scaleFactor
        })
      }
      if (process.env.ELECTRON_RENDERER_URL) {
        void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}#region`)
      } else {
        void win.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'region' })
      }
      win.webContents.once('did-finish-load', () => {
        send()
        win.show()
        win.focus()
      })
      // One handler per window, removed with the window. Resolves the FIRST
      // selection: the user drags on one monitor, and the others are just dismissed.
      win.webContents.ipc.handle('region:result', (_e, sel: Selection | null) => {
        finish(sel ? { grab, sel } : null)
      })
    }
  })

  closeAll()
  if (!picked) return null

  const { grab, sel } = picked
  // sharp, not nativeImage.crop: nativeImage rounds to DIP and we need exact source
  // pixels. sharp is already a dependency and already asarUnpack'd.
  const sharp = (await import('sharp')).default
  const meta = { width: Math.round(grab.display.size.width * grab.display.scaleFactor), height: Math.round(grab.display.size.height * grab.display.scaleFactor) }
  const rect = cropRect(sel, grab.display.scaleFactor, meta)
  if (!rect) return null
  try {
    await sharp(grab.png).extract(rect).png().toFile(outPath)
    return outPath
  } catch (err) {
    console.error('[screenshot] crop failed:', err)
    return null
  }
}
