import { describe, it, expect } from 'vitest'
import { pickPayloadKind, readPlan, snapshotFrom, verifyClipboardText } from './clipboardIO'

/**
 * Format precedence is one line of ordering and the highest-frequency silent
 * data-loss item in the Windows port, so it is table-driven against the real shapes
 * `clipboard.availableFormats()` reports.
 *
 * The linux and darwin rows are the point of the table: they must be identical to
 * the image-first rule that shipped, because X11 and NSPasteboard genuinely do put
 * an image on the clipboard only when the user copied an image.
 */
const cases: Array<{ what: string; formats: string[]; win: 'image' | 'text'; other: 'image' | 'text' }> = [
  {
    // Select three cells in Excel, Ctrl+C. CF_DIB rides along with CF_UNICODETEXT,
    // so image-first stores a PICTURE of the cells and discards the text: not
    // searchable, not enrichable, and nothing to paste into an editor.
    what: 'Excel range copy',
    formats: ['text/plain', 'text/html', 'image/png'],
    win: 'text',
    other: 'image'
  },
  {
    what: 'Word table copy',
    formats: ['text/html', 'text/plain', 'text/rtf', 'image/png'],
    win: 'text',
    other: 'image'
  },
  {
    what: 'a real screenshot (Win+Shift+S)',
    formats: ['image/png'],
    win: 'image',
    other: 'image'
  },
  {
    what: 'an image copied from a browser, with its source URL',
    formats: ['image/png', 'text/uri-list'],
    win: 'image',
    other: 'image'
  },
  {
    // Right-click a picture in Chrome, "Copy image". Blink writes CF_DIB and a
    // CF_HTML `<img src=…>` fragment and NO CF_UNICODETEXT, so calling this text
    // meant readText() returned '' and the bitmap was dropped without a log line.
    // CF_HTML is not evidence of text; CF_UNICODETEXT is.
    what: 'an image copied from a browser, with its HTML fragment',
    formats: ['text/html', 'image/png'],
    win: 'image',
    other: 'image'
  },
  { what: 'plain text', formats: ['text/plain'], win: 'text', other: 'text' },
  { what: 'nothing at all', formats: [], win: 'text', other: 'text' },
  {
    what: 'an X11 image selection',
    formats: ['TARGETS', 'image/png', 'image/bmp'],
    win: 'image',
    other: 'image'
  }
]

describe('pickPayloadKind', () => {
  for (const c of cases) {
    it(`${c.what}: win32=${c.win}, linux/darwin=${c.other}`, () => {
      expect(pickPayloadKind(c.formats, 'win32')).toBe(c.win)
      expect(pickPayloadKind(c.formats, 'linux')).toBe(c.other)
      expect(pickPayloadKind(c.formats, 'darwin')).toBe(c.other)
    })
  }

  it('is image-first for every case on linux and darwin', () => {
    // Stated separately from the table so a future edit to a win32 row cannot
    // quietly drag the other two platforms along with it.
    for (const c of cases) {
      const expected = c.formats.some((f) => f.startsWith('image/')) ? 'image' : 'text'
      expect(pickPayloadKind(c.formats, 'linux')).toBe(expected)
      expect(pickPayloadKind(c.formats, 'darwin')).toBe(expected)
    }
  })
})

describe('readPlan', () => {
  it('always leaves the other flavour as a fallback on win32', () => {
    // The read was asymmetric: 'image' fell back to text, 'text' never looked at the
    // image. Every win32 mis-guess therefore produced {text: ''}, and CaptureService
    // returns on an empty hash before it logs anything at all.
    expect(readPlan(['text/html', 'image/png'], 'win32')).toEqual(['image', 'text'])
    expect(readPlan(['text/plain', 'image/png'], 'win32')).toEqual(['text', 'image'])
    expect(readPlan(['image/png'], 'win32')).toEqual(['image', 'text'])
  })

  it('has nothing to fall back to when the clip holds no image', () => {
    expect(readPlan(['text/plain'], 'win32')).toEqual(['text'])
    expect(readPlan([], 'darwin')).toEqual(['text'])
  })

  it('reads exactly what it read before on linux and darwin', () => {
    // The hard constraint on this file: the win32 fix must not add a single
    // clipboard read on a platform that shipped. Image-first with a text fallback
    // when the bitmap is empty, and text alone otherwise — nothing else.
    for (const c of cases) {
      const expected = c.formats.some((f) => f.startsWith('image/')) ? ['image', 'text'] : ['text']
      expect(readPlan(c.formats, 'linux')).toEqual(expected)
      expect(readPlan(c.formats, 'darwin')).toEqual(expected)
    }
  })
})

describe('snapshotFrom', () => {
  const png = Buffer.from('fake png bytes')
  const readers = (image: Buffer | null, text: string): { image: () => Buffer | null; text: () => string } => ({
    image: () => image,
    text: () => text
  })

  it('keeps an image whose only text flavour is CF_HTML', () => {
    // The reported defect, end to end: Chrome's "Copy image" reports
    // ['text/html','image/png'] and readText() is '' — this used to return
    // {text: ''}, which the capture tick discards silently.
    const snap = snapshotFrom(['text/html', 'image/png'], 'win32', readers(png, ''))
    expect(snap.image).toEqual(png)
    expect(snap.text).toBe('')
  })

  it('keeps the text of an Excel range copy, bitmap and all', () => {
    const snap = snapshotFrom(['text/plain', 'text/html', 'image/png'], 'win32', readers(png, 'a\tb\tc'))
    expect(snap.text).toBe('a\tb\tc')
    expect(snap.image).toBeUndefined()
  })

  it('falls back to the bitmap when a win32 text guess reads back empty', () => {
    const snap = snapshotFrom(['text/plain', 'image/png'], 'win32', readers(png, ''))
    expect(snap.image).toEqual(png)
  })

  it('falls back to text when the bitmap will not decode', () => {
    // Pre-existing behaviour, kept: an image format that yields an empty
    // NativeImage must not shadow text that is really there.
    const snap = snapshotFrom(['image/png', 'text/plain'], 'darwin', readers(null, 'hello'))
    expect(snap.text).toBe('hello')
  })

  it('never asks darwin for a flavour the shipped code did not ask for', () => {
    // Proof that the win32 fix did not reach the other platforms: for a text clip
    // the image reader is not called at all, on darwin or linux.
    for (const platform of ['darwin', 'linux'] as const) {
      let imageReads = 0
      const snap = snapshotFrom(['text/plain', 'text/html'], platform, {
        image: () => {
          imageReads++
          return png
        },
        text: () => 'hello'
      })
      expect(imageReads).toBe(0)
      expect(snap).toEqual({ formats: ['text/plain', 'text/html'], text: 'hello' })
    }
  })

  it('reports an empty clip rather than inventing one', () => {
    expect(snapshotFrom([], 'win32', readers(null, ''))).toEqual({ formats: [], text: '' })
  })
})

describe('verifyClipboardText', () => {
  const noSleep = async (): Promise<void> => {}

  it('accepts a write that landed', async () => {
    expect(await verifyClipboardText(() => 'hello', 'hello', 3, 0, noSleep)).toBe(true)
  })

  it('retries, because OpenClipboard contention is transient', async () => {
    // Chromium's ScopedClipboardWriter retries OpenClipboard 5x at 5ms and then
    // gives up with no exception and no return value, so a dropped write is normal
    // and invisible. One late success must still count.
    let n = 0
    const read = (): string => (++n < 3 ? '' : 'hello')
    expect(await verifyClipboardText(read, 'hello', 3, 0, noSleep)).toBe(true)
    expect(n).toBe(3)
  })

  it('gives up rather than letting a paste inject the previous clip', async () => {
    expect(await verifyClipboardText(() => 'the thing you copied before', 'hello', 3, 0, noSleep)).toBe(false)
  })

  it('ignores CRLF, which Windows adds to every multi-line clip', async () => {
    // Without this every multi-line paste would report a failed write.
    expect(await verifyClipboardText(() => 'a\r\nb', 'a\nb', 3, 0, noSleep)).toBe(true)
  })

  it('compares only the head, so a large clip costs nothing', async () => {
    const big = 'x'.repeat(5000)
    expect(await verifyClipboardText(() => big, big + 'different tail', 1, 0, noSleep)).toBe(true)
  })
})
