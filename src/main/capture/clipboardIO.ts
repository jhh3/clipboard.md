import { execFile, spawn } from 'child_process'
import { clipboard, nativeImage } from 'electron'

/**
 * Off-main-thread clipboard reads (Linux).
 *
 * Electron's `clipboard.*` reads are synchronous X11 selection transfers on the UI
 * thread. Under mutter's Wayland→X11 selection bridge they can stall for a long time
 * (measured 107ms locally for plain text; mutter#1065 documents outright hangs). A
 * stall of even a few hundred ms starves the WM's frame/ping handshake, which makes
 * GNOME declare the app "Not Responding" mid-drag.
 *
 * So on Linux every read is delegated to `xclip` in a child process with a hard
 * timeout: a slow or hostile selection owner can no longer block the UI thread.
 * macOS keeps the native path — NSPasteboard reads don't have this problem.
 */

const READ_TIMEOUT_MS = 1500
const MAX_BYTES = 32 * 1024 * 1024

export interface ClipboardSnapshot {
  formats: string[]
  text: string
  /** PNG bytes when the selection holds an image. */
  image?: Buffer
}

function xclip(args: string[], encoding: 'utf8' | 'buffer'): Promise<Buffer | string | null> {
  return new Promise((resolve) => {
    execFile(
      'xclip',
      args,
      { timeout: READ_TIMEOUT_MS, maxBuffer: MAX_BYTES, encoding: encoding === 'buffer' ? 'buffer' : 'utf8' },
      (err, stdout) => resolve(err ? null : (stdout as Buffer | string))
    )
  })
}

async function readLinux(): Promise<ClipboardSnapshot> {
  const targets = (await xclip(['-selection', 'clipboard', '-o', '-t', 'TARGETS'], 'utf8')) as
    | string
    | null
  const formats = targets ? targets.split('\n').map((s) => s.trim()).filter(Boolean) : []

  const imageTarget = formats.find((f) => f === 'image/png') ?? formats.find((f) => f.startsWith('image/'))
  if (imageTarget) {
    const buf = (await xclip(['-selection', 'clipboard', '-o', '-t', imageTarget], 'buffer')) as
      | Buffer
      | null
    if (buf && buf.length > 0) return { formats, text: '', image: buf }
  }

  const hasText = formats.some((f) => f === 'UTF8_STRING' || f === 'text/plain' || f === 'STRING')
  if (!hasText && formats.length > 0) return { formats, text: '' }
  const text = (await xclip(['-selection', 'clipboard', '-o'], 'utf8')) as string | null
  return { formats, text: text ?? '' }
}

/** Read the clipboard without blocking the UI thread. */
export async function readClipboard(): Promise<ClipboardSnapshot> {
  if (process.platform === 'linux') return readLinux()
  const formats = clipboard.availableFormats()
  if (formats.some((f) => f.startsWith('image/'))) {
    const img = clipboard.readImage()
    if (!img.isEmpty()) return { formats, text: '', image: img.toPNG() }
  }
  return { formats, text: clipboard.readText() }
}

/** HTML flavor, fetched only when a text clip reports one (also off-thread on Linux). */
export async function readHtml(): Promise<string | undefined> {
  if (process.platform !== 'linux') return clipboard.readHTML() || undefined
  const html = (await xclip(['-selection', 'clipboard', '-o', '-t', 'text/html'], 'utf8')) as
    | string
    | null
  return html || undefined
}

/**
 * Write the clipboard through a detached `xclip` owner process.
 *
 * Critical on this stack: whoever owns the X CLIPBOARD selection must answer every
 * other app's paste request promptly. If our Electron process owned it and its UI
 * thread was busy for even a moment, mutter — which bridges X selections to Wayland
 * clients on its single compositor thread — blocks waiting on us, and the ENTIRE
 * desktop freezes until the X selection timeout (~15-20s, observed). Handing
 * ownership to a tiny dedicated process removes that hazard completely: it has
 * nothing to do but serve the bytes.
 */
export function writeClipboardText(text: string): Promise<void> {
  if (process.platform !== 'linux') {
    clipboard.writeText(text)
    return Promise.resolve()
  }
  return spawnOwner(['-selection', 'clipboard'], Buffer.from(text, 'utf8'))
}

export function writeClipboardImage(png: Buffer): Promise<void> {
  if (process.platform !== 'linux') {
    clipboard.writeImage(nativeImage.createFromBuffer(png))
    return Promise.resolve()
  }
  return spawnOwner(['-selection', 'clipboard', '-t', 'image/png'], png)
}

export function writeClipboardHtml(html: string, text: string): Promise<void> {
  if (process.platform !== 'linux') {
    clipboard.write({ text, html })
    return Promise.resolve()
  }
  // xclip owns one target per process; the HTML flavor is the useful one here.
  return spawnOwner(['-selection', 'clipboard', '-t', 'text/html'], Buffer.from(html, 'utf8'))
}

function spawnOwner(args: string[], data: Buffer): Promise<void> {
  return new Promise((resolve) => {
    // `xclip -i` stays resident as the selection owner; detach it so it outlives
    // this call and never blocks us (or dies with us mid-transfer).
    const child = spawn('xclip', [...args, '-i'], { detached: true, stdio: ['pipe', 'ignore', 'ignore'] })
    child.unref()
    child.on('error', (err) => {
      console.error('[clipboard] xclip write failed:', err)
      resolve()
    })
    child.stdin.on('error', () => resolve())
    child.stdin.end(data, () => resolve())
  })
}

/**
 * True when our own process owns the X CLIPBOARD selection. Requesting a selection
 * we own means asking ourselves for data — a self-deadlock risk that can take the
 * compositor down with it. Callers skip reads when this is true.
 */
export function weOwnClipboard(): boolean {
  return ownedUntil > Date.now()
}

let ownedUntil = 0

/** Mark that we (or our detached owner process) just took the clipboard. */
export function markOwnedByUs(ms = 1500): void {
  ownedUntil = Date.now() + ms
}

/** PRIMARY selection (what is highlighted right now) — used by the rewrite hotkey. */
export async function readPrimarySelection(): Promise<string> {
  if (process.platform !== 'linux') return clipboard.readText()
  const text = (await xclip(['-selection', 'primary', '-o'], 'utf8')) as string | null
  return text ?? ''
}
