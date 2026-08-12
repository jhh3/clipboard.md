import { describe, it, expect } from 'vitest'
import { cropRect, matchSource } from './regionCapture'

/**
 * The crop maths, which is the part that fails QUIETLY.
 *
 * A wrong rectangle does not throw — it returns the wrong part of the picture, which
 * reads as "the screenshot tool is a bit off" and is nearly impossible to attribute
 * to a scale factor. On a mixed-DPI desk (a 150% laptop panel beside a 100%
 * external, the ordinary Windows setup) the factor differs per monitor, so this has
 * to be right per display rather than once.
 */
const SOURCE_1X = { width: 1920, height: 1080 }
const SOURCE_150 = { width: 2880, height: 1620 } // 1920x1080 at 150%

describe('cropRect', () => {
  it('is identity at 100%', () => {
    expect(cropRect({ x: 100, y: 50, width: 300, height: 200 }, 1, SOURCE_1X)).toEqual({
      left: 100,
      top: 50,
      width: 300,
      height: 200
    })
  })

  it('scales CSS pixels to source pixels at 150%', () => {
    expect(cropRect({ x: 100, y: 50, width: 300, height: 200 }, 1.5, SOURCE_150)).toEqual({
      left: 150,
      top: 75,
      width: 450,
      height: 300
    })
  })

  it('handles a drag up and to the left', () => {
    // The overlay reports raw start/current points, so a right-to-left drag arrives
    // with negative width. Passing that to sharp throws.
    expect(cropRect({ x: 400, y: 250, width: -300, height: -200 }, 1, SOURCE_1X)).toEqual({
      left: 100,
      top: 50,
      width: 300,
      height: 200
    })
  })

  it('clamps a drag that left the window', () => {
    // A drag past the edge reports coordinates outside the window, and sharp throws
    // "extract_area: bad extract area" for a rect that overhangs by one pixel.
    expect(cropRect({ x: -50, y: -50, width: 5000, height: 5000 }, 1, SOURCE_1X)).toEqual({
      left: 0,
      top: 0,
      width: 1920,
      height: 1080
    })
  })

  it('treats a click without a drag as a cancel', () => {
    // sharp throws on a 0x0 extract, and a 1px image in the history is worse than
    // nothing at all.
    expect(cropRect({ x: 10, y: 10, width: 0, height: 0 }, 1, SOURCE_1X)).toBeNull()
    expect(cropRect({ x: 10, y: 10, width: 1, height: 40 }, 1, SOURCE_1X)).toBeNull()
  })

  it('never returns a rect that overhangs the source', () => {
    for (const scale of [1, 1.25, 1.5, 2]) {
      const source = { width: Math.round(1920 * scale), height: Math.round(1080 * scale) }
      const r = cropRect({ x: 1900, y: 1000, width: 500, height: 500 }, scale, source)!
      expect(r.left + r.width, `scale ${scale}`).toBeLessThanOrEqual(source.width)
      expect(r.top + r.height, `scale ${scale}`).toBeLessThanOrEqual(source.height)
    }
  })
})

describe('matchSource', () => {
  const sources = [
    { id: 'screen:0:0', display_id: '111' },
    { id: 'screen:1:0', display_id: '222' }
  ]

  it('matches on display_id', () => {
    expect(matchSource(sources, { id: 222 }, 0)?.id).toBe('screen:1:0')
  })

  it('falls back to index when the driver reports no display_id', () => {
    // Empty display_id happens on some drivers. On a single-monitor machine —
    // i.e. most of them — refusing to guess would mean no capture at all.
    const blank = [{ id: 'screen:0:0', display_id: '' }]
    expect(matchSource(blank, { id: 999 }, 0)?.id).toBe('screen:0:0')
  })

  it('returns undefined rather than the wrong screen when the index is out of range', () => {
    expect(matchSource([], { id: 1 }, 3)).toBeUndefined()
  })
})
