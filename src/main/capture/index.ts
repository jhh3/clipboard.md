import { clipboard, app, nativeImage } from 'electron'
import { createHash } from 'crypto'
import { writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import type { ClipKind } from '@shared/types'
import { upsertClip, enqueueEnrichment } from '../store/items'
import { runFilters } from './filters'
import { getSettings } from '../settings'

export interface CaptureEvents {
  onItem: (id: number, created: boolean) => void
}

const URL_RE = /^(https?:\/\/|www\.)\S+$/i
const COLOR_RE = /^(#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|rgba?\([\d\s.,%]+\)|hsla?\([\d\s.,%deg]+\))$/i

function classifyText(text: string): ClipKind {
  const t = text.trim()
  if (URL_RE.test(t)) return 'link'
  if (COLOR_RE.test(t)) return 'color'
  return 'text'
}

function imagesDir(): string {
  const dir = join(app.getPath('userData'), 'data', 'images')
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Polling capture loop over Electron's clipboard API.
 *
 * On Linux we run under Xwayland: mutter mirrors the Wayland CLIPBOARD selection into
 * X11 regardless of focus (verified on GNOME 50.1), so a background poll sees every copy
 * from both Wayland-native and X11 apps. On macOS the same poll works against
 * NSPasteboard. Change detection is via content hash of the cheapest available flavor;
 * an XFixes-event upgrade can replace the timer without touching anything above it.
 */
export class CaptureService {
  private timer: ReturnType<typeof setInterval> | null = null
  private lastHash = ''
  /** Hash the service itself just wrote (paste/copy actions) — skip one echo. */
  private selfHash = ''
  private events: CaptureEvents

  constructor(events: CaptureEvents) {
    this.events = events
  }

  start(): void {
    if (this.timer) return
    // Prime lastHash so whatever is on the clipboard at launch isn't re-captured.
    this.lastHash = this.snapshotHash()
    const interval = getSettings().pollIntervalMs
    this.timer = setInterval(() => this.tick(), interval)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Call before programmatically writing to the clipboard so we don't capture our own writes. */
  markSelfWrite(text?: string): void {
    // The next tick's snapshot will match this hash and be ignored once.
    this.selfHash = text !== undefined ? this.hashText(text) : '*any*'
  }

  private hashText(text: string): string {
    return createHash('sha256').update('text').update(text).digest('hex')
  }

  private snapshotHash(): string {
    const formats = clipboard.availableFormats()
    if (formats.some((f) => f.startsWith('image/'))) {
      const img = clipboard.readImage()
      if (!img.isEmpty()) {
        return createHash('sha256').update('image').update(img.toBitmap()).digest('hex')
      }
    }
    const text = clipboard.readText()
    return text ? this.hashText(text) : ''
  }

  private tick(): void {
    try {
      const settings = getSettings()
      if (!settings.captureEnabled) return

      const formats = clipboard.availableFormats()
      const isImage = formats.some((f) => f.startsWith('image/'))
      const text = isImage ? '' : clipboard.readText()
      if (!isImage && !text) return

      const hash = isImage ? this.snapshotHash() : text ? this.hashText(text) : ''
      if (!hash || hash === this.lastHash) return
      if (this.selfHash === '*any*' || hash === this.selfHash) {
        this.selfHash = ''
        this.lastHash = hash
        return
      }
      this.lastHash = hash

      if (isImage) this.captureImage(formats)
      else this.captureText(text, formats)
    } catch (err) {
      // Never let a capture hiccup kill the loop.
      console.error('[capture] tick failed:', err)
    }
  }

  private captureText(text: string, formats: string[]): void {
    const settings = getSettings()
    const { verdict, reason } = runFilters({ text, formats, ignoreApps: settings.ignoreApps })
    if (verdict === 'skip') return

    const kind = classifyText(text)
    const html = formats.includes('text/html') ? clipboard.readHTML() : undefined
    const { id, created } = upsertClip({
      kind,
      content: text,
      html,
      preview: text.slice(0, 500),
      secret: verdict === 'store-secret'
    })
    if (created && verdict === 'store' && settings.enrichment.enabled) {
      enqueueEnrichment(id)
    }
    if (verdict === 'store-secret') {
      console.log(`[capture] stored secret-flagged clip (${reason}), excluded from index`)
    }
    this.events.onItem(id, created)
  }

  private captureImage(formats: string[]): void {
    const settings = getSettings()
    const { verdict } = runFilters({ formats, ignoreApps: settings.ignoreApps })
    if (verdict === 'skip') return

    const img = clipboard.readImage()
    if (img.isEmpty()) return
    const result = ingestNativeImage(img)
    if (!result) return
    this.events.onItem(result.id, result.created)
  }

  /** Ingest an image file (e.g. a portal screenshot) as a first-class clip. */
  ingestImageFile(path: string): { id: number; created: boolean } | null {
    const img = nativeImage.createFromPath(path)
    if (img.isEmpty()) return null
    const result = ingestNativeImage(img)
    if (result) this.events.onItem(result.id, result.created)
    return result
  }
}

function ingestNativeImage(img: Electron.NativeImage): { id: number; created: boolean } | null {
  const png = img.toPNG()
  const sha = createHash('sha256').update(png).digest('hex')
  const file = join(imagesDir(), `${sha}.png`)
  if (!existsSync(file)) writeFileSync(file, png)

  const { width, height } = img.getSize()
  const thumb = img.resize({ width: Math.min(320, width) }).toDataURL()

  const result = upsertClip({
    kind: 'image',
    content: file,
    preview: `Image ${width}x${height}`,
    thumb,
    width,
    height,
    secret: false
  })
  if (result.created && getSettings().enrichment.enabled) enqueueEnrichment(result.id)
  return result
}
