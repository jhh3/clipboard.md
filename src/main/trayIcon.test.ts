import { describe, it, expect } from 'vitest'
import { execFileSync } from 'child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { TRAY_BASE_SIZE, windowsTrayFrames } from './trayIcon'

/**
 * The Windows tray icon, decoded by the decoder that will actually decode it.
 *
 * This file exists because inlined base64 image data reads as correct to every
 * reviewer and to the type system, and the previous blobs were a real, valid,
 * multi-frame .ico that `nativeImage.createFromBuffer` cannot read at all — it tries
 * PNG, then JPEG, then a raw-pixel fallback needing an explicit size. Every Windows
 * build got isEmpty() === true, `createTray` threw into its own catch, and the app
 * ran with no tray icon: no window, no Dock icon, no way to reach it. Nothing short
 * of running the bytes through Electron would have caught that, so that is what the
 * last test here does.
 */

/** The Electron we ship, resolved without importing the package (which is a path). */
function electronBinary(): string | null {
  const pkg = join(process.cwd(), 'node_modules', 'electron')
  const pathFile = join(pkg, 'path.txt')
  if (!existsSync(pathFile)) return null
  const bin = join(pkg, 'dist', readFileSync(pathFile, 'utf8').trim())
  return existsSync(bin) ? bin : null
}

/** Width and height straight out of the PNG IHDR chunk. */
function pngSize(buf: Buffer): { width: number; height: number } {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

describe('windowsTrayFrames', () => {
  for (const taskbarIsLight of [true, false]) {
    const which = taskbarIsLight ? 'black (light taskbar)' : 'white (dark taskbar)'

    it(`${which}: every frame is a PNG, not a container format`, () => {
      // The exact regression: an .ico's ICONDIR header (00 00 01 00 ...) sails past
      // any check that is not this one, and nativeImage has no ICO decoder.
      for (const f of windowsTrayFrames(taskbarIsLight)) {
        expect(f.buffer.subarray(0, 8), `${f.size}px frame is not a PNG`).toEqual(PNG_MAGIC)
      }
    })

    it(`${which}: is rendered at each size Windows asks for`, () => {
      const frames = windowsTrayFrames(taskbarIsLight)
      // 16px at 100% scaling, then 125/150/200/300%. A single bitmap downscaled to
      // 16px turns the glyph's 1.5px strokes into grey mush, which is why there are
      // five of these and not one.
      expect(frames.map((f) => f.size)).toEqual([16, 20, 24, 32, 48])
      for (const f of frames) {
        expect(pngSize(f.buffer)).toEqual({ width: f.size, height: f.size })
        // Electron selects a representation by scale factor, never by pixel size.
        expect(f.scaleFactor).toBe(f.size / TRAY_BASE_SIZE)
      }
      // Base representation first: tray.ts builds the image from frames[0] and adds
      // the rest, so an unsorted map would tag the 48px bitmap as the 1x one.
      expect(frames[0].scaleFactor).toBe(1)
    })
  }

  it('gives the light and dark taskbars different bitmaps', () => {
    // Same glyph, opposite colour. Serving one for both is the black-on-black (or
    // white-on-white) failure this file's sibling comment describes: the icon is
    // present and clickable and completely invisible.
    const black = windowsTrayFrames(true)
    const white = windowsTrayFrames(false)
    expect(black.map((f) => f.size)).toEqual(white.map((f) => f.size))
    for (let i = 0; i < black.length; i++) {
      expect(black[i].buffer.equals(white[i].buffer)).toBe(false)
    }
  })
})

describe('the real nativeImage decodes the tray icon', () => {
  const bin = electronBinary()

  // Skipped only when the Electron binary is absent (a `--ignore-scripts` install).
  // If it is there, it runs: a decode failure here is the difference between a
  // Windows build having a tray icon and not having one.
  it.skipIf(!bin)(
    'to a non-empty image carrying every scale factor',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'clipmd-trayicon-'))
      try {
        for (const taskbarIsLight of [true, false]) {
          const frames = windowsTrayFrames(taskbarIsLight)
          const json = join(dir, `frames-${taskbarIsLight}.json`)
          writeFileSync(
            json,
            JSON.stringify(
              frames.map((f) => ({ scaleFactor: f.scaleFactor, base64: f.buffer.toString('base64') }))
            )
          )
          // No command-line switches: passing any of them (even --disable-gpu) makes
          // this Electron initialise the display platform before it runs the script,
          // and it then aborts on a machine with no $DISPLAY. The sandbox is turned
          // off through the environment instead, for CI containers running as root.
          const out = execFileSync(
            bin as string,
            [join(process.cwd(), 'scripts', 'decode-tray-icon.cjs'), json],
            {
              encoding: 'utf8',
              timeout: 60_000,
              env: { ...process.env, ELECTRON_DISABLE_SANDBOX: '1' }
            }
          )
          const report = JSON.parse(out.trim().split('\n').pop() as string)

          for (const f of report.perFrame) {
            expect(f.empty, `frame @${f.scaleFactor}x decoded to nothing`).toBe(false)
            // Size is reported in DIPs, so every representation is the 16pt icon.
            expect(f.size).toEqual({ width: TRAY_BASE_SIZE, height: TRAY_BASE_SIZE })
          }
          // And the assembled image — what `new Tray()` is actually handed.
          expect(report.composed.empty, 'the tray image decoded to nothing').toBe(false)
          expect(report.composed.size).toEqual({ width: TRAY_BASE_SIZE, height: TRAY_BASE_SIZE })
          expect(report.composed.scaleFactors).toEqual(frames.map((f) => f.scaleFactor))
        }
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
    120_000
  )
})
