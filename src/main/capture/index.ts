import { app, nativeImage } from 'electron'
import { spawn, type ChildProcess } from 'child_process'
import { readClipboard, readHtml, weOwnClipboard } from './clipboardIO'
import { helperPath } from '../mac/helper'
import { getSourceApp, type SourceApp } from './sourceApp'
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
  /** macOS pasteboard watcher child process, when event-driven capture is running. */
  private watcher: ChildProcess | null = null
  private reading = false
  private paused = false
  private lastHash = ''
  /** Hash the service itself just wrote (paste/copy actions) — skip one echo. */
  private selfHash = ''
  private selfHashExpires = 0
  private events: CaptureEvents

  constructor(events: CaptureEvents) {
    this.events = events
  }

  start(): void {
    this.paused = false
    if (this.timer || this.watcher) return
    // Prime lastHash so whatever is on the clipboard at launch isn't re-captured.
    void this.tick(true)
    if (process.platform === 'linux') {
      // Every failure path below must fall back to polling: silently capturing
      // nothing for a whole session is the worst possible outcome for this app.
      this.startXFixesPush().then((ok) => {
        if (ok) console.log('[capture] event-driven (XFixes); polling disabled')
        else this.startPolling('XFixes unavailable')
      })
    } else if (process.platform === 'darwin') {
      this.startPasteboardWatcher().then((ok) => {
        if (ok) console.log('[capture] event-driven (pasteboard watcher); polling disabled')
        else this.startPolling('pasteboard watcher unavailable')
      })
    } else {
      this.startPolling('platform has no clipboard events')
    }
  }

  /**
   * Event-driven capture on macOS.
   *
   * NSPasteboard has no change notification, so someone must poll `changeCount`. Doing
   * it here meant reading the entire pasteboard every tick just to discover nothing had
   * changed — and for images that means a full PNG re-encode: measured at 55.7ms per
   * poll with a screenshot on the pasteboard, every 400ms, on the thread that must
   * never block (~14% of a core, indefinitely, for a clipboard nobody touched).
   *
   * The helper polls changeCount in its own process — a cheap call in something with
   * nothing else to do — and writes a line when it actually changes. We then read the
   * clipboard once, on a real change. Same shape as the Linux XFixes path, and it
   * falls back to polling on any failure for the same reason.
   */
  private startPasteboardWatcher(): Promise<boolean> {
    return new Promise((resolve) => {
      const path = helperPath()
      if (!path) return resolve(false)
      let settled = false
      const done = (ok: boolean): void => {
        if (settled) return
        settled = true
        resolve(ok)
      }
      try {
        const child = spawn(path, ['watch', '--interval-ms', '250'], {
          stdio: ['pipe', 'pipe', 'ignore']
        })
        this.watcher = child
        child.stdout.setEncoding('utf8')
        // The first line is the baseline changeCount at startup, not a change.
        let primed = false
        child.stdout.on('data', (chunk: string) => {
          done(true)
          for (const line of chunk.split('\n')) {
            if (!line.trim()) continue
            if (!primed) {
              primed = true
              continue
            }
            void this.tick()
          }
        })
        child.on('error', () => done(false))
        child.on('exit', (code) => {
          this.watcher = null
          // A watcher that dies mid-session would silently stop all capture.
          if (!this.paused) {
            console.error(`[capture] pasteboard watcher exited (${code}); falling back to polling`)
            this.startPolling('watcher exited')
          }
          done(false)
        })
        // If it never produces its baseline line, treat it as unusable.
        setTimeout(() => done(false), 3000)
      } catch {
        done(false)
      }
    })
  }

  private startPolling(reason: string): void {
    if (this.timer) return
    console.log(`[capture] polling every ${getSettings().pollIntervalMs}ms (${reason})`)
    this.timer = setInterval(() => void this.tick(), getSettings().pollIntervalMs)
  }

  /**
   * Event-driven capture: XFixes SetSelectionOwner notifications. Resolves false if
   * the X connection can't be established or the extension isn't usable, so the
   * caller can start polling instead.
   */
  private startXFixesPush(): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false
      const done = (ok: boolean, why?: string): void => {
        if (settled) return
        settled = true
        if (!ok) console.error(`[capture] XFixes unavailable: ${why}`)
        resolve(ok)
      }
      // If the X handshake never calls back at all, don't hang capture forever.
      setTimeout(() => done(false, 'timed out connecting to X'), 3000)
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const x11 = require('x11') as { createClient: (cb: (err: Error | null, d: any) => void) => void }
        x11.createClient((err: Error | null, display: any) => {
          if (err) return done(false, err.message)
          const X = display.client
          X.require('fixes', (ferr: Error | null, Fixes: any) => {
            if (ferr) return done(false, `fixes extension: ${ferr.message}`)
            const root = display.screen[0].root
            X.InternAtom(false, 'CLIPBOARD', (aerr: Error | null, clipAtom: number) => {
              if (aerr) return done(false, `InternAtom: ${aerr.message}`)
              Fixes.SelectSelectionInput(root, clipAtom, 1 /* SetSelectionOwner */)
              X.on('event', (ev: { name?: string }) => {
                if (ev.name === 'SelectionNotify') {
                  // Owner changed; give the new owner a beat to serve targets.
                  setTimeout(() => void this.tick(), 60)
                }
              })
              done(true)
            })
          })
          X.on('error', (e: Error) => console.error('[capture] x11 event error:', e.message))
        })
      } catch (err) {
        done(false, String(err))
      }
    })
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    // Set before killing: the exit handler checks it to tell a deliberate stop
    // (lock/suspend) from a crash it should fall back to polling for.
    this.paused = true
    if (this.watcher) {
      this.watcher.kill()
      this.watcher = null
    }
  }

  /** Re-read settings that were only sampled at startup (poll interval, enabled). */
  applySettings(): void {
    if (!this.timer) return // event-driven; nothing interval-based to retune
    clearInterval(this.timer)
    this.timer = null
    this.startPolling('settings changed')
  }

  /** Call before programmatically writing to the clipboard so we don't capture our own writes. */
  markSelfWrite(text?: string): void {
    // The next tick's snapshot will match this hash and be ignored once.
    this.selfHash = text !== undefined ? this.hashText(text) : '*any*'
    // '*any*' must expire: without this, pasting an image armed a wildcard that
    // silently swallowed whatever the user copied next, minutes later.
    this.selfHashExpires = Date.now() + 2000
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
    if (this.paused) return // session locked or suspended
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
      const selfArmed = this.selfHash !== '' && Date.now() < this.selfHashExpires
      if (selfArmed && (this.selfHash === '*any*' || hash === this.selfHash)) {
        this.selfHash = ''
        this.lastHash = hash
        return
      }
      this.lastHash = hash
      // Priming at startup: remember what's already there, don't capture it.
      if (prime) return

      // Resolve the source app before storing so the ignore-list can actually act.
      const sourceApp = await getSourceApp()
      if (snap.image) this.captureImageBuffer(snap.image, snap.formats, sourceApp)
      else await this.captureText(snap.text, snap.formats, sourceApp)
    } catch (err) {
      console.error('[capture] tick failed:', err)
    } finally {
      this.reading = false
    }
  }

  private async captureText(text: string, formats: string[], sourceApp?: SourceApp): Promise<void> {
    const settings = getSettings()
    const { verdict, reason } = runFilters({
      text,
      formats,
      sourceApp: sourceApp?.name,
      sourceAppId: sourceApp?.id,
      ignoreApps: settings.ignoreApps
    })
    if (verdict === 'skip') return

    const kind = classifyText(text)
    const html = formats.includes('text/html') ? await readHtml() : undefined
    const { id, created } = upsertClip({
      kind,
      content: text,
      html,
      preview: text.slice(0, 500),
      sourceApp: sourceApp?.name,
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

  private captureImageBuffer(png: Buffer, formats: string[], sourceApp?: SourceApp): void {
    const { verdict } = runFilters({
      formats,
      sourceApp: sourceApp?.name,
      sourceAppId: sourceApp?.id,
      ignoreApps: getSettings().ignoreApps
    })
    if (verdict === 'skip') return
    const img = nativeImage.createFromBuffer(png)
    if (img.isEmpty()) return
    const result = ingestNativeImage(img, sourceApp?.name)
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

function ingestNativeImage(img: Electron.NativeImage, sourceApp?: string): { id: number; created: boolean } | null {
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
    secret: false,
    sourceApp
  })
  if (result.created && getSettings().enrichment.enabled) enqueueEnrichment(result.id)
  return result
}
