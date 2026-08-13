import { execFile, spawn } from 'child_process'
import { clipboard, nativeImage } from 'electron'
import { LINUX, WIN32, currentPlatform, type Platform } from '../platform'

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

/**
 * Which flavour of a multi-format clip we should actually store.
 *
 * This is the highest-frequency silent data-loss item in the Windows port, and it is
 * one line of ordering. Excel, Word, Outlook and PowerPoint put a CF_DIB bitmap on
 * the clipboard alongside CF_UNICODETEXT for an ORDINARY TEXT copy — select three
 * cells, press Ctrl+C, and Chromium reports both `image/png` and `text/plain`. The
 * image-first rule then stores a picture of the cells and throws the text away: no
 * search, no enrichment, nothing to paste into an editor. The user copied text and
 * the history shows a screenshot.
 *
 * X11 and NSPasteboard do not behave this way — an image copy there is an image copy
 * — so the existing image-first rule is kept verbatim for linux and darwin. This is
 * a pure function precisely so that can be asserted.
 *
 * Only `text/plain` counts as that evidence. `text/html` used to count too, and it
 * is the wrong signal in the one direction that loses the whole clip: Chromium's
 * "Copy image" writes CF_DIB *and* CF_HTML (an `<img src=…>` fragment) with no
 * CF_UNICODETEXT, so an image copied from a browser reported ['text/html',
 * 'image/png'], was called text, and `clipboard.readText()` returned '' because
 * Windows never synthesises plain text from CF_HTML. The capture tick then saw an
 * empty hash and returned before it logged anything — the bitmap gone, silently.
 * A rich-text copy that genuinely holds text always carries CF_UNICODETEXT beside
 * its CF_HTML, so nothing that is really text is lost by ignoring the HTML flavour.
 *
 * UNVERIFIED, and the whole basis of the win32 rule: that Chromium really does
 * report `image/png` for a CF_DIB accompanying an Excel text copy. It needs one
 * manual confirmation on a real Windows box.
 */
export type PayloadKind = 'image' | 'text'

export function pickPayloadKind(formats: string[], platform: Platform): PayloadKind {
  if (!formats.some((f) => f.startsWith('image/'))) return 'text'
  if (platform !== 'win32') return 'image'
  return formats.includes('text/plain') ? 'text' : 'image'
}

/**
 * Which flavours to actually try, in order, for a clip with these formats.
 *
 * The read used to be asymmetric: choosing 'image' fell back to text when the
 * bitmap came back empty, but choosing 'text' never looked at the image even when
 * the format list said one was there. So any win32 clip we mis-read as text
 * produced `{text: ''}` and the payload was dropped without a log line. Whichever
 * way the guess goes, the other flavour is now the fallback.
 *
 * This changes nothing on linux or darwin: there 'text' is only ever chosen when no
 * image format is present at all, so the second step cannot exist. Asserted.
 */
export function readPlan(formats: string[], platform: Platform): Array<'image' | 'text'> {
  if (pickPayloadKind(formats, platform) === 'image') return ['image', 'text']
  return formats.some((f) => f.startsWith('image/')) ? ['text', 'image'] : ['text']
}

async function readLinux(): Promise<ClipboardSnapshot> {
  const targets = (await xclip(['-selection', 'clipboard', '-o', '-t', 'TARGETS'], 'utf8')) as
    | string
    | null
  const formats = targets ? targets.split('\n').map((s) => s.trim()).filter(Boolean) : []

  const imageTarget =
    pickPayloadKind(formats, 'linux') === 'image'
      ? (formats.find((f) => f === 'image/png') ?? formats.find((f) => f.startsWith('image/')))
      : undefined
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

/**
 * Walk the plan and keep the first flavour that actually produced something.
 *
 * The readers are injected for the same reason `verifyClipboardText`'s is: the
 * ordering here is what silently discarded an entire image clip on Windows, and
 * injected readers make it provable from a machine that is not Windows — including
 * the negative, that darwin never reads a flavour it did not read before.
 */
export function snapshotFrom(
  formats: string[],
  platform: Platform,
  read: { image: () => Buffer | null; text: () => string }
): ClipboardSnapshot {
  for (const flavour of readPlan(formats, platform)) {
    if (flavour === 'image') {
      const png = read.image()
      if (png && png.length > 0) return { formats, text: '', image: png }
    } else {
      const text = read.text()
      if (text !== '') return { formats, text }
    }
  }
  return { formats, text: '' }
}

/** Read the clipboard without blocking the UI thread. */
export async function readClipboard(): Promise<ClipboardSnapshot> {
  if (LINUX) return readLinux()
  return snapshotFrom(clipboard.availableFormats(), currentPlatform(), {
    image: () => {
      const img = clipboard.readImage()
      return img.isEmpty() ? null : img.toPNG()
    },
    text: () => clipboard.readText()
  })
}

/** HTML flavor, fetched only when a text clip reports one (also off-thread on Linux). */
export async function readHtml(): Promise<string | undefined> {
  if (!LINUX) return clipboard.readHTML() || undefined
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
  if (!LINUX) {
    clipboard.writeText(text)
    return Promise.resolve()
  }
  return spawnOwner(['-selection', 'clipboard'], Buffer.from(text, 'utf8'))
}

export function writeClipboardImage(png: Buffer): Promise<void> {
  if (!LINUX) {
    clipboard.writeImage(nativeImage.createFromBuffer(png))
    return Promise.resolve()
  }
  return spawnOwner(['-selection', 'clipboard', '-t', 'image/png'], png)
}

export function writeClipboardHtml(html: string, text: string): Promise<void> {
  if (!LINUX) {
    clipboard.write({ text, html })
    return Promise.resolve()
  }
  // xclip owns ONE target per process, and publishing text/html alone makes the
  // clipboard unreadable to everything that asks for plain text — which is almost
  // everything. A 2314-character clip with an HTML flavor pasted into neither a
  // terminal nor Slack, because both request UTF8_STRING and the selection offered
  // only text/html (verified: `TARGETS` listed `TARGETS text/html` and nothing else).
  //
  // So Linux publishes the plain text. Losing rich formatting is a real cost, but a
  // clip that cannot be pasted anywhere is not a tradeoff, it is a broken clipboard.
  // Serving both flavours needs a selection owner that answers multiple targets, and
  // owning the selection in-process is what previously froze the desktop.
  return writeClipboardText(text)
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
 * Wait until the selection actually holds what we just wrote.
 *
 * Flushing stdin to `xclip` is not the same as `xclip` having taken ownership of
 * the X selection. Injecting Ctrl+V before that happens pastes the *previous*
 * clipboard contents — or nothing. The gap scales with payload size, so short
 * clips appeared to work while longer ones silently failed.
 */
export async function waitForClipboard(expected: string, timeoutMs = 800): Promise<boolean> {
  if (LINUX) {
    const deadline = Date.now() + timeoutMs
    const head = expected.slice(0, 64)
    while (Date.now() < deadline) {
      const got = (await xclip(['-selection', 'clipboard', '-o'], 'utf8')) as string | null
      if (got !== null && got.slice(0, 64) === head) return true
      await new Promise((r) => setTimeout(r, 25))
    }
    return false
  }
  if (WIN32) {
    return verifyClipboardText(() => clipboard.readText(), expected)
  }
  return true
}

/**
 * Read the clipboard back on Windows and confirm it holds what we just wrote.
 *
 * `clipboard.writeText` returns void whether or not it worked. Underneath, Chromium's
 * ScopedClipboardWriter retries OpenClipboard five times at 5ms and then GIVES UP —
 * no exception, no return value, nothing. OpenClipboard contention is real and
 * routine on Windows (any app can hold it, and several poll it), so the write simply
 * does not happen sometimes. Injecting Ctrl+V after that pastes the PREVIOUS clip
 * into whatever the user is typing in, which is worse than not pasting at all.
 *
 * A read-back costs microseconds here — unlike Linux, where the same question means
 * an X selection round-trip — so three tries at 15ms is cheap insurance.
 *
 * Line endings are normalised before comparing. Windows clipboard text is CRLF by
 * convention, and a mismatch on `\r` alone would make every multi-line paste report
 * a failed write.
 */
export async function verifyClipboardText(
  read: () => string,
  expected: string,
  tries = 3,
  waitMs = 15,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))
): Promise<boolean> {
  const norm = (s: string): string => s.replace(/\r\n/g, '\n').slice(0, 64)
  const head = norm(expected)
  for (let i = 0; i < tries; i++) {
    if (norm(read()) === head) return true
    await sleep(waitMs)
  }
  return false
}

/**
 * The image equivalent of waitForClipboard, and it exists for the same reason.
 *
 * `clipboard.writeImage` returns void whether or not it worked: Electron routes it
 * through the same Chromium ScopedClipboardWriter that gives up after five
 * OpenClipboard attempts at 5ms with no exception and no return value. The image
 * paste path was the only one of the three that then injected Ctrl+V without
 * checking — text and HTML both verify — so a dropped write pasted the PREVIOUS clip
 * into whatever the user was typing in, and every step reported success.
 *
 * Dimensions rather than bytes, because bytes cannot round-trip: Windows carries the
 * image as a CF_DIB and the PNG we read back is a re-encode. Matching dimensions
 * still separates the two cases that matter — our image is there, versus the old
 * clipboard content (text, nothing, or a different picture) still is.
 *
 * A no-op returning true anywhere but Windows. On Linux the write goes to a detached
 * xclip owner and reading it back would be asking ourselves for a selection we own —
 * the self-request that can take mutter's bridge down with it.
 */
export async function waitForClipboardImage(png: Buffer): Promise<boolean> {
  if (!WIN32) return true
  const expected = nativeImage.createFromBuffer(png).getSize()
  // Nothing to compare against; the caller has bigger problems than verification.
  if (expected.width === 0 || expected.height === 0) return true
  return verifyClipboardImage(() => {
    const img = clipboard.readImage()
    return img.isEmpty() ? null : img.getSize()
  }, expected)
}

/** The retry loop, with the read injected — see verifyClipboardText. */
export async function verifyClipboardImage(
  read: () => { width: number; height: number } | null,
  expected: { width: number; height: number },
  tries = 3,
  waitMs = 15,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))
): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    const got = read()
    if (got && got.width === expected.width && got.height === expected.height) return true
    await sleep(waitMs)
  }
  return false
}

/**
 * True when our own process owns the X CLIPBOARD selection. Requesting a selection
 * we own means asking ourselves for data — a self-deadlock risk that can take the
 * compositor down with it. Callers skip reads when this is true.
 */
export function weOwnClipboard(): boolean {
  if (WIN32) return false
  return ownedUntil > Date.now()
}

let ownedUntil = 0

/**
 * Mark that we (or our detached owner process) just took the clipboard.
 *
 * A no-op on Windows, and only on Windows. The hazard this guards against is an X11
 * one: requesting a selection we own means asking ourselves for data, and a
 * self-request that stalls takes mutter's selection bridge down with it. Windows has
 * no selection ownership and no such deadlock — the clipboard is a system-owned
 * buffer — so all this did there was blind the capture loop for 1500ms after every
 * copy and paste. Echo suppression on Windows is markSelfWrite's job, which is
 * content-addressed and therefore precise.
 *
 * macOS has no such hazard either and is left alone DELIBERATELY: changing it is a
 * behaviour change to a shipping platform, which this port is not allowed to make.
 * Filed separately.
 */
export function markOwnedByUs(ms = 1500): void {
  if (WIN32) return
  ownedUntil = Date.now() + ms
}

/**
 * PRIMARY selection (what is highlighted right now) — used by the rewrite hotkey.
 *
 * Returns null where there is no such thing, and callers MUST refuse rather than
 * substitute. The old fallback here was `clipboard.readText()`, which is not a
 * degraded answer to "what is selected" — it is a confident answer to a different
 * question. Press the rewrite hotkey with nothing selected and the app would take
 * whatever you last copied, rewrite it with a model, and paste the result over your
 * cursor. That is the worst failure in this whole port: silent, destructive, and
 * indistinguishable from working.
 *
 * macOS reaches the real selection through the helper's accessibility chain and
 * never calls this (see index.ts currentSelection).
 */
export async function readPrimarySelection(): Promise<string | null> {
  if (!LINUX) return null
  const text = (await xclip(['-selection', 'primary', '-o'], 'utf8')) as string | null
  return text ?? ''
}
