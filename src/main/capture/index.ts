import { app } from 'electron'
import { spawn, type ChildProcess } from 'child_process'
import sharp from 'sharp'
import { readClipboard, readHtml, weOwnClipboard } from './clipboardIO'
import { helperPath } from '../mac/helper'
import { getSourceApp, type SourceApp } from './sourceApp'
import { createHash } from 'crypto'
import { mkdirSync, existsSync } from 'fs'
import { readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import type { ClipKind } from '@shared/types'
import { upsertClip, enqueueEnrichment } from '../store/items'
import { runFilters } from './filters'
import { getSettings } from '../settings'
import { considerSnapshot } from '../corrections'
import { MACOS, LINUX } from '../platform'
import { onClipboardOwnerChange, onXLost, xconn, hasOwnerEvents } from '../xconn'

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
 * Clipboard capture, event-driven where the platform allows it.
 *
 * On Linux we run under Xwayland: mutter mirrors the Wayland CLIPBOARD selection into
 * X11 regardless of focus (verified on GNOME 50.1), so XFixes owner-change events see
 * every copy from both Wayland-native and X11 apps. macOS uses the helper's
 * pasteboard watcher. Polling is the fallback on both. Change detection is by
 * content hash.
 */
export class CaptureService {
  private timer: ReturnType<typeof setInterval> | null = null
  /** macOS pasteboard watcher child process, when event-driven capture is running. */
  private watcher: ChildProcess | null = null
  /** Unsubscribes from the shared X connection's owner events (Linux). */
  private xOff: (() => void) | null = null
  private reading = false
  /**
   * A change arrived while a read was in flight. That read may already have fetched
   * the OLD content, so dropping the event (as this used to) lost a quick second copy;
   * the read re-runs once it finishes instead.
   */
  private dirty = false
  /** When the change event behind the current read arrived, for the timing line. */
  private eventAt = 0
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
    if (this.timer || this.watcher || this.xOff) return
    // Prime lastHash so whatever is on the clipboard at launch isn't re-captured.
    void this.tick(true)
    if (LINUX) {
      // Every failure path below must fall back to polling: silently capturing
      // nothing for a whole session is the worst possible outcome for this app.
      void this.startXFixesPush().then((ok) => {
        if (ok) console.log('[capture] event-driven (XFixes); polling disabled')
        else this.startPolling('XFixes unavailable')
      })
    } else if (MACOS) {
      void this.startPasteboardWatcher().then((ok) => {
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
   * Event-driven capture: XFixes SetSelectionOwner notifications on the shared X
   * connection (xconn.ts). Resolves false when X or XFixes is unusable, so the caller
   * can poll instead.
   *
   * This used to open its own X connection on every start(), and stop() closed none
   * of them, so each unlock and resume leaked one. Subscribing to the shared
   * connection makes stop/start a listener swap.
   */
  private async startXFixesPush(): Promise<boolean> {
    if (!(await xconn()) || !hasOwnerEvents()) return false
    if (this.paused || this.xOff) return !!this.xOff
    const offOwner = onClipboardOwnerChange(() => {
      // Owner changed; give the new owner a beat to serve targets.
      const at = Date.now()
      setTimeout(() => void this.tick(false, at), 60)
    })
    const offLost = onXLost(() => {
      this.xOff?.()
      this.xOff = null
      if (this.paused) return
      // Xwayland restarted under us. Reconnect if it is back, poll if not.
      setTimeout(() => {
        if (this.paused || this.xOff || this.timer) return
        void this.startXFixesPush().then((ok) => {
          if (ok) console.log('[capture] X connection re-established')
          else this.startPolling('X connection lost')
        })
      }, 2000)
    })
    this.xOff = () => {
      offOwner()
      offLost()
    }
    return true
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    // Set before killing: the exit handler checks it to tell a deliberate stop
    // (lock/suspend/quit) from a crash it should fall back to polling for.
    this.paused = true
    this.xOff?.()
    this.xOff = null
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
  private async tick(prime = false, eventAt = Date.now()): Promise<void> {
    if (this.reading) {
      this.dirty = true
      return
    }
    // Never request a selection we own — that is asking ourselves for data, and a
    // self-request that stalls takes the compositor's bridge down with it.
    if (weOwnClipboard()) return
    if (this.paused) return // session locked or suspended
    this.reading = true
    this.eventAt = eventAt
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
      if (snap.image) await this.captureImageBuffer(snap.image, snap.formats, sourceApp)
      else await this.captureText(snap.text, snap.formats, sourceApp)
    } catch (err) {
      console.error('[capture] tick failed:', err)
    } finally {
      this.reading = false
      if (this.dirty) {
        this.dirty = false
        void this.tick()
      }
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
    // A foreign copy may be the user re-copying a transcript they just corrected —
    // let the learn-from-corrections pass have a look. Cheap no-op unless enabled.
    considerSnapshot(text, sourceApp?.name ?? null)
    console.log(`[timing] capture ${Date.now() - this.eventAt}ms (text)`)
    this.events.onItem(id, created)
  }

  private async captureImageBuffer(bytes: Buffer, formats: string[], sourceApp?: SourceApp): Promise<void> {
    const { verdict } = runFilters({
      formats,
      sourceApp: sourceApp?.name,
      sourceAppId: sourceApp?.id,
      ignoreApps: getSettings().ignoreApps
    })
    if (verdict === 'skip') return
    const result = await ingestImageBytes(bytes, sourceApp?.name)
    if (!result) return
    console.log(`[timing] capture ${Date.now() - this.eventAt}ms (image)`)
    this.events.onItem(result.id, result.created)
  }

  /** Ingest an image file (e.g. a portal screenshot) as a first-class clip. */
  async ingestImageFile(path: string): Promise<{ id: number; created: boolean } | null> {
    try {
      const result = await ingestImageBytes(await readFile(path))
      if (result) this.events.onItem(result.id, result.created)
      return result
    } catch (err) {
      console.error('[capture] could not ingest image file:', err)
      return null
    }
  }
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const THUMB_WIDTH = 320

/**
 * Store an image clip without touching the main thread for pixel work.
 *
 * PNG bytes are kept exactly as the clipboard served them: decoding and re-encoding a
 * 4K screenshot on the main thread cost 100-400ms per copy and bought nothing. Other
 * formats are converted to PNG once. Dimensions and the thumbnail come from sharp,
 * which runs on the libuv pool.
 */
async function ingestImageBytes(
  bytes: Buffer,
  sourceApp?: string
): Promise<{ id: number; created: boolean } | null> {
  const isPng = bytes.length > 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)
  let png: Buffer
  let width: number
  let height: number
  let thumb: string
  try {
    png = isPng ? bytes : await sharp(bytes).png().toBuffer()
    const meta = await sharp(png).metadata()
    width = meta.width ?? 0
    height = meta.height ?? 0
    if (!width || !height) return null
    const small = await sharp(png)
      .resize({ width: Math.min(THUMB_WIDTH, width), withoutEnlargement: true })
      .png()
      .toBuffer()
    thumb = `data:image/png;base64,${small.toString('base64')}`
  } catch (err) {
    console.error('[capture] image decode failed:', err)
    return null
  }
  const sha = createHash('sha256').update(png).digest('hex')
  const file = join(imagesDir(), `${sha}.png`)
  if (!existsSync(file)) await writeFile(file, png)

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
