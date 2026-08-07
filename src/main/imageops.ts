import sharp from 'sharp'

/**
 * Local image operations for image Action Mode. All pure-local, no AI required.
 * Auto-redact: tesseract gives word bounding boxes; anything matching sensitive
 * patterns gets a solid block composited over it.
 */

const SENSITIVE_WORD = new RegExp(
  [
    '@', // emails
    '^(?:AKIA|ASIA|ghp_|gho_|sk-|xox[baprs]-|AIza|eyJ)', // key prefixes
    '^[A-Za-z0-9+/_-]{24,}$', // long opaque tokens
    '^(?:\\+?\\d[\\d\\s().-]{8,})$', // phone-ish
    '\\d{4,}' // long digit runs (accounts, cards, ids)
  ].join('|')
)

interface Word {
  text: string
  bbox: { x0: number; y0: number; x1: number; y1: number }
}

async function ocrWords(png: Buffer): Promise<Word[]> {
  const { createWorker } = await import('tesseract.js')
  const worker = await createWorker('eng')
  try {
    const { data } = await worker.recognize(png)
    const words: Word[] = []
    for (const block of data.blocks ?? []) {
      for (const para of block.paragraphs ?? []) {
        for (const line of para.lines ?? []) {
          for (const w of line.words ?? []) {
            words.push({ text: w.text, bbox: w.bbox })
          }
        }
      }
    }
    return words
  } finally {
    await worker.terminate()
  }
}

/** Redact sensitive-looking text; returns PNG + how many regions were covered. */
export async function autoRedact(pngPath: string): Promise<{ png: Buffer; count: number }> {
  const base = sharp(pngPath)
  const meta = await base.metadata()
  const png = await base.png().toBuffer()
  const words = await ocrWords(png)
  const hits = words.filter((w) => w.text.length >= 4 && SENSITIVE_WORD.test(w.text))
  if (hits.length === 0) return { png, count: 0 }

  const overlays = hits.map((w) => {
    const pad = 2
    const width = Math.min((meta.width ?? 0) - w.bbox.x0, w.bbox.x1 - w.bbox.x0 + pad * 2)
    const height = Math.min((meta.height ?? 0) - w.bbox.y0, w.bbox.y1 - w.bbox.y0 + pad * 2)
    return {
      input: {
        create: {
          width: Math.max(1, Math.round(width)),
          height: Math.max(1, Math.round(height)),
          channels: 4 as const,
          background: { r: 24, g: 24, b: 32, alpha: 1 }
        }
      },
      left: Math.max(0, Math.round(w.bbox.x0 - pad)),
      top: Math.max(0, Math.round(w.bbox.y0 - pad))
    }
  })
  const out = await sharp(png).composite(overlays).png().toBuffer()
  return { png: out, count: hits.length }
}

export async function convertImage(
  pngPath: string,
  format: 'png' | 'jpeg',
  quality = 90
): Promise<{ buffer: Buffer; mime: string }> {
  const s = sharp(pngPath)
  if (format === 'jpeg') {
    return { buffer: await s.jpeg({ quality }).toBuffer(), mime: 'image/jpeg' }
  }
  return { buffer: await s.png().toBuffer(), mime: 'image/png' }
}
