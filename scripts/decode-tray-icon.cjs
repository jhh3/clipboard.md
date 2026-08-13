/**
 * Decode tray bitmaps with the REAL nativeImage and report what came back.
 *
 * Run under the Electron binary, not node — the whole point is that this is
 * Chromium's decoder and not a JS one. src/main/trayIcon.test.ts spawns it with the
 * exact buffers and scale factors the Windows build uses, because the bug this
 * exists to prevent is inlined image data that every reviewer reads as valid and
 * that nativeImage silently decodes to a 0x0 empty image (which is what the
 * multi-frame .ico blobs did on Electron 43.2.0).
 *
 *   electron scripts/decode-tray-icon.cjs <frames.json>
 *
 * frames.json: [{ "scaleFactor": 1, "base64": "..." }, ...], base representation
 * first. Prints one JSON object on stdout and exits.
 *
 * CommonJS deliberately, and it is load-bearing. Electron requires the main script
 * synchronously, before it initialises the display platform, so everything here
 * finishes and exits first. As ESM the load is asynchronous, Ozone gets there first,
 * and on a machine with no $DISPLAY it aborts the process ("Missing X server") — the
 * test would then be un-runnable on exactly the headless CI boxes that need it.
 * nativeImage decoding itself needs no display.
 */
const { readFileSync } = require('fs')
const { app, nativeImage } = require('electron')

const frames = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const [base, ...rest] = frames

const perFrame = frames.map((f) => {
  const img = nativeImage.createFromBuffer(Buffer.from(f.base64, 'base64'), {
    scaleFactor: f.scaleFactor
  })
  return { scaleFactor: f.scaleFactor, empty: img.isEmpty(), size: img.getSize() }
})

const composed = nativeImage.createFromBuffer(Buffer.from(base.base64, 'base64'), {
  scaleFactor: base.scaleFactor
})
for (const f of rest) {
  composed.addRepresentation({ scaleFactor: f.scaleFactor, buffer: Buffer.from(f.base64, 'base64') })
}

console.log(
  JSON.stringify({
    perFrame,
    composed: {
      empty: composed.isEmpty(),
      size: composed.getSize(),
      scaleFactors: composed.getScaleFactors ? composed.getScaleFactors() : []
    }
  })
)
app.exit(0)
