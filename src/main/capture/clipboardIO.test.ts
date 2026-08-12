import { describe, it, expect } from 'vitest'
import { pickPayloadKind, verifyClipboardText } from './clipboardIO'

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
