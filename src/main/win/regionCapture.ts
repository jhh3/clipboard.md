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

export interface PixelSize {
  width: number
  height: number
}

/** What a display's grab should measure, in real pixels. */
export function displayPixelSize(display: {
  size: { width: number; height: number }
  scaleFactor: number
}): PixelSize {
  return {
    width: Math.round(display.size.width * display.scaleFactor),
    height: Math.round(display.size.height * display.scaleFactor)
  }
}

/**
 * The distinct grab sizes a set of displays needs — one getSources call each.
 *
 * There is ONE thumbnailSize per getSources call, and Chromium aspect-FITS every
 * frame into it: it scales up as readily as down (measured against the Electron we
 * ship — a 1280x800 screen asked for 3840x2160 came back 3456x2160, and asked for
 * 100x100 came back 100x63). Passing the per-axis maximum across all displays, as
 * this did, therefore gave every display that was not the largest an UPSCALED grab:
 * a 1920x1080 panel beside a 3840x2160 one returned a 3840x2160 image. The crop then
 * indexed it as if it were 1920x1080 and extracted the wrong region entirely, with
 * no error — the rect is always inside the bigger buffer.
 *
 * Almost every desk has one entry here, so this is almost always one call, exactly
 * as before. Two mismatched monitors cost a second capture, which is the price of
 * the right pixels.
 */
export function distinctPixelSizes(
  displays: Array<{ size: { width: number; height: number }; scaleFactor: number }>
): PixelSize[] {
  const seen = new Map<string, PixelSize>()
  for (const d of displays) {
    const size = displayPixelSize(d)
    seen.set(`${size.width}x${size.height}`, size)
  }
  return [...seen.values()]
}

/**
 * CSS pixels → grab pixels, MEASURED from the image we actually got back.
 *
 * Electron's own docs say "there is no guarantee that the size of the thumbnail is
 * the same as the thumbnailSize specified", and it is not a hypothetical: the fit is
 * uniform, so a frame whose aspect ratio differs from the requested box comes back
 * at neither the requested size nor the display's. Deriving the factor from
 * display.scaleFactor assumes the guarantee that does not exist; dividing by the
 * width we can see does not.
 *
 * Falls back to the declared scale factor only for a zero-width grab, which cannot
 * be divided by and is already rejected upstream as an empty thumbnail.
 */
export function grabScale(cssWidth: number, grab: PixelSize, scaleFactor: number): number {
  if (grab.width <= 0 || cssWidth <= 0) return scaleFactor
  return grab.width / cssWidth
}

interface Grab {
  display: Electron.Display
  png: Buffer
  dataUrl: string
  /** The grab's real pixel size — NOT display.size × scaleFactor. See grabScale. */
  size: PixelSize
}

async function grabScreens(): Promise<Grab[]> {
  const displays = screen.getAllDisplays()
  const out: Array<Grab & { index: number }> = []
  // Thumbnails at full source resolution: this is a screenshot, not a thumbnail, and
  // the default 150x150 would return a postage stamp with no error. One call per
  // distinct size rather than one for all — see distinctPixelSizes.
  for (const thumbnailSize of distinctPixelSizes(displays)) {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize })
    displays.forEach((display, i) => {
      if (out.some((g) => g.index === i)) return
      const want = displayPixelSize(display)
      if (want.width !== thumbnailSize.width || want.height !== thumbnailSize.height) return
      const source = matchSource(sources, display, i)
      if (!source || source.thumbnail.isEmpty()) return
      out.push({
        index: i,
        display,
        png: source.thumbnail.toPNG(),
        dataUrl: source.thumbnail.toDataURL(),
        size: source.thumbnail.getSize()
      })
    })
  }
  // Back into display order: the overlay windows are created from this list, and the
  // index fallback in matchSource only means anything in that order.
  return out.sort((a, b) => a.index - b.index).map(({ index: _index, ...grab }) => grab)
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
  // Both from the grab itself, never from display.size × scaleFactor: desktopCapturer
  // does not promise the size you asked for, and a rect computed in a space the image
  // is not in crops the wrong region silently.
  const rect = cropRect(sel, grabScale(grab.display.size.width, grab.size, grab.display.scaleFactor), grab.size)
  if (!rect) return null
  try {
    await sharp(grab.png).extract(rect).png().toFile(outPath)
    return outPath
  } catch (err) {
    console.error('[screenshot] crop failed:', err)
    return null
  }
}
