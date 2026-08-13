import { app, nativeImage } from 'electron'
import { spawn, type ChildProcess } from 'child_process'
import { readClipboard, readHtml, weOwnClipboard } from './clipboardIO'
import { helperPath } from '../mac/helper'
import { parseWatchLine, watcherCommand, watcherScript } from '../win/sequenceWatcher'
import { getSourceApp, type SourceApp } from './sourceApp'
import { createHash } from 'crypto'
import { writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import type { ClipKind } from '@shared/types'
import { upsertClip, enqueueEnrichment } from '../store/items'
import { runFilters } from './filters'
import { getSettings } from '../settings'
import { considerSnapshot } from '../corrections'
import { MACOS, LINUX, WIN32 } from '../platform'
import { downgradeCapability } from '../capabilities'

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
  /**
   * Whether the clipboard content this tick is marked "do not record" by Windows'
   * concealed-content formats. Set by the sidecar immediately before the tick it
   * describes; see runFilters' `concealedWin`.
   *
   * Defaults to false and is CLEARED after every tick, because a stale true would
   * silently drop the next ordinary clip, and a stale false is the one thing we must
   * never carry into a password.
   */
  private concealedWin = false
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
    if (LINUX) {
      // Every failure path below must fall back to polling: silently capturing
      // nothing for a whole session is the worst possible outcome for this app.
      this.startXFixesPush().then((ok) => {
        if (ok) console.log('[capture] event-driven (XFixes); polling disabled')
        else this.startPolling('XFixes unavailable')
      })
    } else if (MACOS) {
      this.startPasteboardWatcher().then((ok) => {
        if (ok) console.log('[capture] event-driven (pasteboard watcher); polling disabled')
        else this.startPolling('pasteboard watcher unavailable')
      })
    } else if (WIN32) {
      this.startWindowsWatcher().then((ok) => {
        if (ok) console.log('[capture] event-driven (clipboard sequence watcher); polling disabled')
        else this.startPolling('clipboard sequence watcher unavailable')
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

  /**
   * Event-driven capture on Windows.
   *
   * Same shape as the macOS pasteboard watcher, and for the same reason: polling
   * from here means reading the whole clipboard every tick to discover nothing
   * changed. The sidecar reads GetClipboardSequenceNumber, which — crucially — does
   * NOT require OpenClipboard. A background tool that opens the clipboard on a timer
   * is how another app ends up reporting "We couldn't free up space on the
   * Clipboard"; we must never be the cause of that.
   *
   * The exit → polling fallback is mandatory, not defensive tidiness: `Add-Type` is
   * blocked outright under Constrained Language Mode, AppLocker and several EDR
   * products, which are common on exactly the managed machines where a clipboard
   * manager silently capturing nothing for a whole session would go unnoticed.
   */
  private startWindowsWatcher(): Promise<boolean> {
    return new Promise((resolve) => {
      const script = watcherScript(process.resourcesPath ?? '', __dirname)
      if (!script) {
        console.error('[capture] clipwatch.ps1 not found; falling back to polling')
        return resolve(false)
      }
      let settled = false
      const done = (ok: boolean): void => {
        if (settled) return
        settled = true
        resolve(ok)
      }
      try {
        const { cmd, args } = watcherCommand(script)
        const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
        this.watcher = child
        child.stdout.setEncoding('utf8')
        // stderr is where Add-Type reports being blocked. Silence there would make an
        // AppLocker machine indistinguishable from a working one.
        child.stderr?.setEncoding('utf8')
        child.stderr?.on('data', (chunk: string) => {
          const text = chunk.trim()
          if (text) console.error(`[capture] clipwatch: ${text}`)
        })
        // The first line is the baseline sequence number at startup, not a change.
        let primed = false
        let buffered = ''
        child.stdout.on('data', (chunk: string) => {
          done(true)
          buffered += chunk
          const lines = buffered.split('\n')
          buffered = lines.pop() ?? ''
          for (const line of lines) {
            const ev = parseWatchLine(line)
            if (!ev) continue
            if (!primed) {
              primed = true
              continue
            }
            // Held for the duration of this tick only. It describes THIS clipboard
            // content, and by the next event the user may have copied something else.
            this.concealedWin = ev.concealed
            void this.tick()
          }
        })
        child.on('error', () => done(false))
        child.on('exit', (code) => {
          this.watcher = null
          if (!this.paused) {
            console.error(`[capture] clipboard watcher exited (${code}); falling back to polling`)
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
    if (WIN32) {
      // Polling on Windows means no sidecar, and no sidecar means no concealed-format
      // detection AT ALL. `this.concealedWin` is assigned in exactly one place — the
      // sidecar's stdout handler — so every polling tick passes false, and the other
      // concealed check cannot cover for it either: CONCEALED_FORMATS lists
      // NSPasteboard and KDE names, and clipboard.availableFormats() cannot see
      // Windows' registered formats in the first place. The registry went on
      // reporting this as supported while the app recorded every password copied out
      // of a password manager. That is exactly the silent-failure shape this port
      // exists to remove, so it is said out loud instead — in Settings, in --doctor,
      // and in the log line downgradeCapability writes.
      downgradeCapability('concealedFormatHints', {
        state: 'unsupported',
        reason:
          'The clipboard sidecar is not running, so password managers’ “do not record” markers cannot be read this session — copies from them WILL be stored. Its own error is in the log above; Constrained Language Mode, AppLocker and some EDR products block the Add-Type it needs. Restart the app once the block is lifted.'
      })
    }
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

      // Windows resolves the source app BEFORE the read, not after.
      //
      // The sidecar's poll interval already puts up to 250ms between the copy and
      // this tick, and reading the clipboard adds more; asking afterwards names
      // whichever app the user has tabbed TO. A wrong answer here is worse than
      // none, because "sourceApp: 1password.exe" is what the ignore list acts on —
      // and the mirror of that, naming the wrong app, means the copy from the
      // password manager is stored.
      //
      // linux and darwin keep the existing ordering deliberately. The same race
      // exists there and is narrower (both have event-driven detection with no
      // 250ms floor); changing it is a behaviour change to a shipping platform and
      // belongs in its own commit.
      const early = WIN32 ? await getSourceApp() : undefined

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
      const sourceApp = early ?? (await getSourceApp())
      if (snap.image) this.captureImageBuffer(snap.image, snap.formats, sourceApp)
      else await this.captureText(snap.text, snap.formats, sourceApp)
    } catch (err) {
      console.error('[capture] tick failed:', err)
    } finally {
      this.reading = false
      // One tick, one verdict. Not clearing this is how a single concealed copy
      // would go on suppressing every clip after it.
      this.concealedWin = false
    }
  }

  private async captureText(text: string, formats: string[], sourceApp?: SourceApp): Promise<void> {
    const settings = getSettings()
    const { verdict, reason } = runFilters({
      text,
      formats,
      sourceApp: sourceApp?.name,
      sourceAppId: sourceApp?.id,
      concealedWin: this.concealedWin,
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
    this.events.onItem(id, created)
  }

  private captureImageBuffer(png: Buffer, formats: string[], sourceApp?: SourceApp): void {
    const { verdict } = runFilters({
      formats,
      sourceApp: sourceApp?.name,
      sourceAppId: sourceApp?.id,
      concealedWin: this.concealedWin,
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
