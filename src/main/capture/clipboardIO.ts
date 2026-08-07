import { execFile } from 'child_process'
import { clipboard } from 'electron'

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

/** PRIMARY selection (what is highlighted right now) — used by the rewrite hotkey. */
export async function readPrimarySelection(): Promise<string> {
  if (process.platform !== 'linux') return clipboard.readText()
  const text = (await xclip(['-selection', 'primary', '-o'], 'utf8')) as string | null
  return text ?? ''
}
