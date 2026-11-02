import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import sharp from 'sharp'
import models from '@gutenye/ocr-models/node'
import { recognize, joinLines } from './engine'

function svg(lines: string[]): Buffer {
  const rows = lines
    .map((l, i) => `<text x="40" y="${60 + i * 50}" font-family="DejaVu Sans, Arial, sans-serif" font-size="28">${l}</text>`)
    .join('')
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="900" height="${60 + lines.length * 50}"><rect width="100%" height="100%" fill="white"/>${rows}</svg>`)
}

describe('ocr engine', () => {
  it('reads the text in a rendered screenshot, line by line', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'clipmd-ocr-'))
    try {
      const file = join(dir, 'shot.png')
      await sharp(svg(['Deploy failed: connection refused', 'Retry in 30 seconds'])).png().toFile(file)
      const started = Date.now()
      const text = await recognize(models, file)
      console.log(`ocr ${Date.now() - started}ms: ${JSON.stringify(text)}`)
      const lines = text.split('\n')
      expect(lines).toHaveLength(2)
      expect(lines[0].toLowerCase()).toContain('connection refused')
      expect(lines[1].toLowerCase()).toContain('retry in 30')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)

  it('reads JPEGs and transparent PNGs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'clipmd-ocr-'))
    try {
      const jpg = join(dir, 'shot.jpg')
      await sharp(svg(['Invoice total 1,250.00 USD'])).jpeg({ quality: 85 }).toFile(jpg)
      expect((await recognize(models, jpg)).toLowerCase()).toContain('invoice total')
      // Black text on a transparent background must not read as black on black.
      const png = join(dir, 'alpha.png')
      const clear = Buffer.from(svg(['Transparent background text']).toString().replace('fill="white"', 'fill="none"'))
      await sharp(clear).png().toFile(png)
      expect((await recognize(models, png)).toLowerCase()).toContain('transparent background')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)

  it('returns nothing for a blank image', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'clipmd-ocr-'))
    try {
      const file = join(dir, 'blank.png')
      await sharp({ create: { width: 400, height: 300, channels: 3, background: '#ffffff' } }).png().toFile(file)
      expect(await recognize(models, file)).toBe('')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)

  it('orders boxes into rows, then left to right', () => {
    const b = (x0: number, y0: number) => ({ x0, y0, x1: x0 + 50, y1: y0 + 20 })
    expect(
      joinLines([
        { box: b(100, 52), text: 'world' },
        { box: b(0, 50), text: 'hello' },
        { box: b(0, 0), text: 'title' }
      ])
    ).toBe('title\nhello world')
  })
})
