import { readFileSync } from 'fs'
import { decode as decodePng } from 'fast-png'
import jpeg from 'jpeg-js'
import * as ort from 'onnxruntime-node'

/**
 * Local screenshot OCR: PaddleOCR v4 (the models RapidOCR ships) on onnxruntime-node.
 * Detection finds text regions, recognition reads each one. About 0.2–0.5 s per
 * screenshot on CPU, and nothing leaves the machine.
 *
 * Detection post-processing uses axis-aligned connected components rather than
 * OpenCV's rotated contours: screenshots are axis-aligned, and it keeps this module
 * free of a 10 MB opencv.js dependency.
 *
 * Images are decoded and resized in plain JS. sharp segfaults inside an Electron
 * utilityProcess on Linux (exit 139 on the first decode), and this runs in one.
 */

export interface OcrModelPaths {
  detectionPath: string
  recognitionPath: string
  dictionaryPath: string
}

interface Engine {
  det: ort.InferenceSession
  rec: ort.InferenceSession
  chars: string[]
}

let enginePromise: Promise<Engine> | null = null

export function loadEngine(paths: OcrModelPaths): Promise<Engine> {
  if (!enginePromise) {
    enginePromise = (async () => {
      // Sessions from bytes, not paths: inside app.asar a path is not a real file to
      // the native loader, but fs reads it fine.
      const opts: ort.InferenceSession.SessionOptions = { executionProviders: ['cpu'], intraOpNumThreads: 4 }
      const [det, rec] = await Promise.all([
        ort.InferenceSession.create(readFileSync(paths.detectionPath), opts),
        ort.InferenceSession.create(readFileSync(paths.recognitionPath), opts)
      ])
      // CTC label set: blank, the dictionary, then a space.
      const dict = readFileSync(paths.dictionaryPath, 'utf8').split(/\r?\n/)
      if (dict[dict.length - 1] === '') dict.pop()
      return { det, rec, chars: ['', ...dict, ' '] }
    })()
    enginePromise.catch(() => (enginePromise = null))
  }
  return enginePromise
}

/** Longest side the detector sees. Screenshots carry small UI text, so not too small. */
const DET_MAX_SIDE = 1600
const DET_THRESH = 0.3
const BOX_THRESH = 0.5
const UNCLIP_RATIO = 1.6
const REC_HEIGHT = 48
const REC_MAX_WIDTH = 1600
const MIN_LINE_SCORE = 0.5

interface Box {
  x0: number
  y0: number
  x1: number
  y1: number
}

/** Packed RGB pixels. */
interface Rgb {
  data: Uint8Array
  width: number
  height: number
}

/** Decode a PNG or JPEG to RGB, compositing any alpha onto white. Other formats: null. */
export function decodeImage(bytes: Uint8Array): Rgb | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    const img = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: false, maxMemoryUsageInMB: 1024 })
    return { data: img.data, width: img.width, height: img.height }
  }
  if (bytes[0] !== 0x89 || bytes[1] !== 0x50) return null
  const png = decodePng(bytes)
  const { width, height, channels } = png
  const src = png.data
  // 16-bit PNGs: keep the high byte.
  const shift = png.depth === 16 ? 8 : 0
  const max = png.depth === 16 ? 65535 : 255
  const out = new Uint8Array(width * height * 3)
  if (png.palette) {
    for (let i = 0; i < width * height; i++) {
      const c = png.palette[src[i]] ?? [255, 255, 255]
      const a = c.length > 3 ? (c[3] ?? 255) / 255 : 1
      for (let k = 0; k < 3; k++) out[i * 3 + k] = Math.round(c[k] * a + 255 * (1 - a))
    }
    return { data: out, width, height }
  }
  for (let i = 0; i < width * height; i++) {
    const p = i * channels
    const gray = channels < 3
    const a = channels === 4 || channels === 2 ? src[p + channels - 1] / max : 1
    for (let k = 0; k < 3; k++) {
      const v = (gray ? src[p] : src[p + k]) >> shift
      out[i * 3 + k] = a === 1 ? v : Math.round(v * a + 255 * (1 - a))
    }
  }
  return { data: out, width, height }
}

/** Bilinear resample of a region of `img` to w x h (whole image by default). */
function resize(img: Rgb, w: number, h: number, box?: Box): Uint8Array {
  const x0 = box?.x0 ?? 0
  const y0 = box?.y0 ?? 0
  const bw = box ? box.x1 - box.x0 + 1 : img.width
  const bh = box ? box.y1 - box.y0 + 1 : img.height
  const out = new Uint8Array(w * h * 3)
  const sx = bw / w
  const sy = bh / h
  for (let y = 0; y < h; y++) {
    const fy = Math.min(bh - 1, Math.max(0, (y + 0.5) * sy - 0.5))
    const ya = Math.floor(fy)
    const yb = Math.min(bh - 1, ya + 1)
    const ty = fy - ya
    for (let x = 0; x < w; x++) {
      const fx = Math.min(bw - 1, Math.max(0, (x + 0.5) * sx - 0.5))
      const xa = Math.floor(fx)
      const xb = Math.min(bw - 1, xa + 1)
      const tx = fx - xa
      const a = ((y0 + ya) * img.width + x0 + xa) * 3
      const b = ((y0 + ya) * img.width + x0 + xb) * 3
      const c = ((y0 + yb) * img.width + x0 + xa) * 3
      const d = ((y0 + yb) * img.width + x0 + xb) * 3
      const o = (y * w + x) * 3
      for (let k = 0; k < 3; k++) {
        const top = img.data[a + k] + (img.data[b + k] - img.data[a + k]) * tx
        const bot = img.data[c + k] + (img.data[d + k] - img.data[c + k]) * tx
        out[o + k] = top + (bot - top) * ty
      }
    }
  }
  return out
}

export async function recognize(paths: OcrModelPaths, imagePath: string): Promise<string> {
  const engine = await loadEngine(paths)
  const img = decodeImage(readFileSync(imagePath))
  if (!img) return ''
  const W = img.width
  const H = img.height
  if (W < 8 || H < 8) return ''

  const boxes = await detect(engine, img)
  const lines: Array<{ box: Box; text: string }> = []
  for (const box of boxes) {
    const text = await readBox(engine, img, box)
    if (text) lines.push({ box, text })
  }
  return joinLines(lines)
}

async function detect(engine: Engine, img: Rgb): Promise<Box[]> {
  const W = img.width
  const H = img.height
  const scale = Math.min(1, DET_MAX_SIDE / Math.max(W, H))
  const w = Math.max(32, Math.round((W * scale) / 32) * 32)
  const h = Math.max(32, Math.round((H * scale) / 32) * 32)
  const resized = resize(img, w, h)

  // NCHW, BGR channel order (Paddle reads with OpenCV), ImageNet normalisation.
  const mean = [0.406, 0.456, 0.485]
  const std = [0.225, 0.224, 0.229]
  const plane = w * h
  const input = new Float32Array(3 * plane)
  for (let i = 0; i < plane; i++) {
    for (let c = 0; c < 3; c++) {
      input[c * plane + i] = (resized[i * 3 + (2 - c)] / 255 - mean[c]) / std[c]
    }
  }
  const out = await engine.det.run({ [engine.det.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, h, w]) })
  const prob = out[engine.det.outputNames[0]].data as Float32Array

  // Connected components over the thresholded probability map.
  const seen = new Uint8Array(plane)
  const stack: number[] = []
  const boxes: Box[] = []
  const sx = W / w
  const sy = H / h
  for (let start = 0; start < plane; start++) {
    if (seen[start] || prob[start] <= DET_THRESH) continue
    let x0 = w
    let y0 = h
    let x1 = 0
    let y1 = 0
    let sum = 0
    let n = 0
    seen[start] = 1
    stack.push(start)
    while (stack.length) {
      const p = stack.pop()!
      const x = p % w
      const y = (p - x) / w
      sum += prob[p]
      n++
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
      const nbrs = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1]
      for (const q of nbrs) {
        if (q >= 0 && !seen[q] && prob[q] > DET_THRESH) {
          seen[q] = 1
          stack.push(q)
        }
      }
    }
    const bw = x1 - x0 + 1
    const bh = y1 - y0 + 1
    if (Math.min(bw, bh) < 3 || sum / n < BOX_THRESH) continue
    // DB shrinks text regions during training; grow them back (the "unclip" step).
    const d = (bw * bh * UNCLIP_RATIO) / (2 * (bw + bh))
    boxes.push({
      x0: Math.max(0, Math.floor((x0 - d) * sx)),
      y0: Math.max(0, Math.floor((y0 - d) * sy)),
      x1: Math.min(W - 1, Math.ceil((x1 + 1 + d) * sx)),
      y1: Math.min(H - 1, Math.ceil((y1 + 1 + d) * sy))
    })
  }
  return boxes
}

async function readBox(engine: Engine, img: Rgb, box: Box): Promise<string> {
  const bw = box.x1 - box.x0 + 1
  const bh = box.y1 - box.y0 + 1
  if (bw < 4 || bh < 4) return ''
  const w = Math.min(REC_MAX_WIDTH, Math.max(REC_HEIGHT / 4, Math.round((REC_HEIGHT * bw) / bh)))
  const crop = resize(img, w, REC_HEIGHT, box)
  const plane = w * REC_HEIGHT
  const input = new Float32Array(3 * plane)
  for (let i = 0; i < plane; i++) {
    for (let c = 0; c < 3; c++) input[c * plane + i] = crop[i * 3 + (2 - c)] / 127.5 - 1
  }
  const out = await engine.rec.run({
    [engine.rec.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, REC_HEIGHT, w])
  })
  const t = out[engine.rec.outputNames[0]]
  const [, steps, classes] = t.dims as number[]
  const data = t.data as Float32Array

  // Greedy CTC decode.
  let text = ''
  let prev = 0
  let scoreSum = 0
  let scored = 0
  for (let s = 0; s < steps; s++) {
    let best = 0
    let bestP = -Infinity
    const off = s * classes
    for (let c = 0; c < classes; c++) {
      if (data[off + c] > bestP) {
        bestP = data[off + c]
        best = c
      }
    }
    if (best !== 0 && best !== prev) {
      text += engine.chars[best] ?? ''
      scoreSum += bestP
      scored++
    }
    prev = best
  }
  text = text.trim()
  if (!text || scoreSum / scored < MIN_LINE_SCORE) return ''
  return text
}

/** Reading order: rows top to bottom (boxes overlapping vertically share a row), then left to right. */
export function joinLines(items: Array<{ box: Box; text: string }>): string {
  const sorted = [...items].sort((a, b) => a.box.y0 - b.box.y0)
  const rows: Array<Array<{ box: Box; text: string }>> = []
  for (const it of sorted) {
    const row = rows[rows.length - 1]
    const ref = row?.[0].box
    const mid = (it.box.y0 + it.box.y1) / 2
    if (ref && mid > ref.y0 && mid < ref.y1) row.push(it)
    else rows.push([it])
  }
  return rows
    .map((r) => r.sort((a, b) => a.box.x0 - b.box.x0).map((i) => i.text).join(' '))
    .join('\n')
}
