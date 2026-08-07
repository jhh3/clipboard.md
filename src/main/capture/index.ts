import { app, nativeImage } from 'electron'
import { readClipboard, readHtml, weOwnClipboard } from './clipboardIO'
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
  private reading = false
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
    void this.tick(true)
    if (process.platform === 'linux' && this.startXFixesPush()) {
      // Push mode: XFixes owner-change events. No polling at all — every read is a
      // child-process round trip, and doing that on a timer is pure waste (and was
      // stalling the UI thread back when reads were synchronous).
      console.log('[capture] event-driven (XFixes); polling disabled')
    } else {
      // macOS has no clipboard-change notification API; polling is the only option.
      this.timer = setInterval(() => void this.tick(), getSettings().pollIntervalMs)
    }
  }

  /** Event-driven capture: XFixes SetSelectionOwner notifications. Returns success. */
  private startXFixesPush(): boolean {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const x11 = require('x11') as { createClient: (cb: (err: Error | null, d: any) => void) => void }
      x11.createClient((err: Error | null, display: any) => {
        if (err) {
          console.error('[capture] x11 push unavailable, staying on poll:', err.message)
          return
        }
        const X = display.client
        X.require('fixes', (ferr: Error | null, Fixes: any) => {
          if (ferr) return
          const root = display.screen[0].root
          X.InternAtom(false, 'CLIPBOARD', (aerr: Error | null, clipAtom: number) => {
            if (aerr) return
            Fixes.SelectSelectionInput(root, clipAtom, 1 /* SetSelectionOwner */)
            X.on('event', (ev: { name?: string }) => {
              if (ev.name === 'SelectionNotify') {
                // Owner changed; give the new owner a beat to serve targets.
                setTimeout(() => void this.tick(), 60)
              }
            })
          })
        })
        X.on('error', (e: Error) => console.error('[capture] x11 event error:', e.message))
      })
      return true
    } catch (err) {
      console.error('[capture] x11 module unavailable:', err)
      return false
    }
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

  /**
   * Read the clipboard and store anything new. Never touches the clipboard on the
   * UI thread on Linux (see clipboardIO) — a blocked read there stalls the WM
   * frame/ping handshake and GNOME declares the app unresponsive mid-interaction.
   */
  private async tick(prime = false): Promise<void> {
    if (this.reading) return // a read is already in flight; its result supersedes
    // Never request a selection we own — that is asking ourselves for data, and a
    // self-request that stalls takes the compositor's bridge down with it.
    if (weOwnClipboard()) return
    this.reading = true
    try {
      if (!getSettings().captureEnabled) return

      const snap = await readClipboard()
      const hash = snap.image
        ? createHash('sha256').update('image').update(snap.image).digest('hex')
        : snap.text
          ? this.hashText(snap.text)
          : ''
      if (!hash || hash === this.lastHash) return
      if (this.selfHash === '*any*' || hash === this.selfHash) {
        this.selfHash = ''
        this.lastHash = hash
        return
      }
      this.lastHash = hash
      // Priming at startup: remember what's already there, don't capture it.
      if (prime) return

      if (snap.image) this.captureImageBuffer(snap.image, snap.formats)
      else await this.captureText(snap.text, snap.formats)
    } catch (err) {
      console.error('[capture] tick failed:', err)
    } finally {
      this.reading = false
    }
  }

  private async captureText(text: string, formats: string[]): Promise<void> {
    const settings = getSettings()
    const { verdict, reason } = runFilters({ text, formats, ignoreApps: settings.ignoreApps })
    if (verdict === 'skip') return

    const kind = classifyText(text)
    const html = formats.includes('text/html') ? await readHtml() : undefined
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

  private captureImageBuffer(png: Buffer, formats: string[]): void {
    const { verdict } = runFilters({ formats, ignoreApps: getSettings().ignoreApps })
    if (verdict === 'skip') return
    const img = nativeImage.createFromBuffer(png)
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
