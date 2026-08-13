#!/usr/bin/env node
/**
 * Regenerate the Windows tray bitmaps inlined in src/main/tray.ts.
 *
 * Run under SYSTEM node from the repo root, never under Electron: sharp's SVG
 * loader is librsvg, and librsvg inside the Electron process hits a GLib/GTK
 * conflict that takes the process down with SIGSEGV. Paste the emitted lines into
 * TRAY_PNG_WHITE / TRAY_PNG_BLACK.
 *
 * PNG frames, NOT an .ico container. This script used to emit a real multi-frame
 * .ico and tray.ts fed it to `nativeImage.createFromBuffer`, which has no ICO
 * decoder — it tries PNG, then JPEG, then a raw-pixel fallback that needs explicit
 * width/height — so every Windows build got an empty image and no tray icon at all
 * (verified against Electron 43.2.0: isEmpty() === true, size 0x0). ICO is only
 * decoded by `createFromPath`, and only on Windows, which is untestable from here.
 * One PNG per size fed through addRepresentation keeps the reason the .ico existed
 * — a bitmap rendered AT each size rather than one downscaled with a generic filter
 * — on a decoder that is platform-independent and provable.
 *
 * Sizes are the physical pixel sizes Windows asks the notification area for at
 * 100/125/150/200/300% scaling, which is why the scale factors in tray.ts are
 * size/16.
 */
import sharp from 'sharp'

const svg = (c) => `<svg xmlns='http://www.w3.org/2000/svg' width='22' height='22' viewBox='0 0 22 22'><g fill='none' stroke='${c}' stroke-width='1.5' stroke-linejoin='round'><rect x='5' y='4' width='12' height='15' rx='2'/><path d='M8.5 4.5h5a1 1 0 0 0 1-1v-.2a1 1 0 0 0-1-1h-5a1 1 0 0 0-1 1v.2a1 1 0 0 0 1 1z' fill='${c}'/><path d='M8 10h6M8 13.5h4' stroke-linecap='round'/></g></svg>`

const SIZES = [16, 20, 24, 32, 48]

for (const [name, colour] of [['WHITE', 'white'], ['BLACK', 'black']]) {
  console.log(`const TRAY_PNG_${name}: Record<number, string> = {`)
  for (const s of SIZES) {
    const png = await sharp(Buffer.from(svg(colour))).resize(s, s).png({ compressionLevel: 9 }).toBuffer()
    console.log(`  ${s}:`)
    console.log(`    '${png.toString('base64')}',`)
  }
  console.log('}')
}
