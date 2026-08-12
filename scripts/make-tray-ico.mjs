#!/usr/bin/env node
/**
 * Regenerate the Windows tray .ico blobs inlined in src/main/tray.ts.
 *
 * Run under SYSTEM node from the repo root, never under Electron: sharp's SVG
 * loader is librsvg, and librsvg inside the Electron process hits a GLib/GTK
 * conflict that takes the process down with SIGSEGV. Paste the two base64 lines
 * into ICO_WHITE_B64 / ICO_BLACK_B64.
 *
 * A multi-frame .ico rather than one bitmap because Windows asks for 16px in the
 * notification area and 32px in the overflow flyout, and downscaling a single
 * larger bitmap turns 1.5px strokes into grey mush.
 */
import sharp from 'sharp'

const svg = (c) => `<svg xmlns='http://www.w3.org/2000/svg' width='22' height='22' viewBox='0 0 22 22'><g fill='none' stroke='${c}' stroke-width='1.5' stroke-linejoin='round'><rect x='5' y='4' width='12' height='15' rx='2'/><path d='M8.5 4.5h5a1 1 0 0 0 1-1v-.2a1 1 0 0 0-1-1h-5a1 1 0 0 0-1 1v.2a1 1 0 0 0 1 1z' fill='${c}'/><path d='M8 10h6M8 13.5h4' stroke-linecap='round'/></g></svg>`

const SIZES = [16, 20, 24, 32, 48]

async function ico(colour) {
  const pngs = []
  for (const s of SIZES) {
    pngs.push(await sharp(Buffer.from(svg(colour))).resize(s, s).png({ compressionLevel: 9 }).toBuffer())
  }
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(SIZES.length, 4)
  const dir = Buffer.alloc(16 * SIZES.length)
  let offset = 6 + dir.length
  SIZES.forEach((s, i) => {
    const o = i * 16
    dir.writeUInt8(s === 256 ? 0 : s, o)
    dir.writeUInt8(s === 256 ? 0 : s, o + 1)
    dir.writeUInt8(0, o + 2) // palette
    dir.writeUInt8(0, o + 3) // reserved
    dir.writeUInt16LE(1, o + 4) // planes
    dir.writeUInt16LE(32, o + 6) // bpp
    dir.writeUInt32LE(pngs[i].length, o + 8)
    dir.writeUInt32LE(offset, o + 12)
    offset += pngs[i].length
  })
  return Buffer.concat([header, dir, ...pngs])
}

for (const [name, colour] of [['WHITE', 'white'], ['BLACK', 'black']]) {
  const buf = await ico(colour)
  console.log(`${name} ${buf.length} bytes`)
  console.log(buf.toString('base64'))
  console.log('---')
}
