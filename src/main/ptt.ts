import { createReadStream, readFileSync, type ReadStream } from 'fs'
import { spawn, type ChildProcess } from 'child_process'
import { helperPath } from './mac/helper'

/**
 * Real push-to-talk, from evdev key events.
 *
 * Why not the global hotkey: GNOME keybindings only ever deliver key-DOWN, and
 * they re-fire on key repeat. Trying to infer "still held" from those repeats was
 * unreliable by construction — the first repeat only arrives after the system's
 * repeat delay (500ms here), which is indistinguishable from a deliberate second
 * press. Reading evdev gives the actual press and release.
 *
 * PRIVACY: this reads a keyboard device, so it must be beyond reproach. We match
 * only the three keycodes of the dictation chord, never buffer or log key data,
 * and never look at any other key. Nothing here is written to disk or sent
 * anywhere. It also degrades silently: if the device can't be opened (no
 * permission), push-to-talk is simply unavailable and the hotkey toggle remains.
 */

// Linux input-event-codes.h
const EV_KEY = 1
const KEY_LEFTCTRL = 29
const KEY_RIGHTCTRL = 97
const KEY_LEFTALT = 56
const KEY_RIGHTALT = 100
const KEY_SPACE = 57

const CTRL = new Set([KEY_LEFTCTRL, KEY_RIGHTCTRL])
const ALT = new Set([KEY_LEFTALT, KEY_RIGHTALT])
/** Every code we care about; anything else is ignored without inspection. */
const WATCHED = new Set([...CTRL, ...ALT, KEY_SPACE])

// struct input_event on 64-bit: __kernel_ulong_t sec, usec (8+8), __u16 type,
// __u16 code, __s32 value.
const EVENT_SIZE = 24

export interface PttHandlers {
  onPress: () => void
  onRelease: () => void
}

let streams: ReadStream[] = []
let held = { ctrl: false, alt: false, space: false }
let chordActive = false

/**
 * Every event node the kernel exposes with a `kbd` handler.
 *
 * Do NOT try to be clever about capability bitmasks: matching specific EV values
 * picked a System76 motherboard device (EV=120013) and skipped the user's actual
 * keyboard (a Kinesis reporting EV=12001f), so hold-to-talk watched a device that
 * never sees a keystroke. Open them all — devices we can't read are skipped, and
 * events we don't care about are discarded without inspection.
 */
function keyboardDevices(): string[] {
  try {
    const raw = readFileSync('/proc/bus/input/devices', 'utf8')
    return raw
      .split('\n\n')
      .filter((block) => /Handlers=[^\n]*\bkbd\b/.test(block))
      .map((block) => /(event\d+)/.exec(block)?.[1])
      .filter((n): n is string => !!n)
      .map((n) => `/dev/input/${n}`)
  } catch {
    return []
  }
}

/**
 * Start watching for the Ctrl+Alt+Space chord. Returns false when no keyboard
 * device could be opened, so the caller can fall back to the toggle.
 */
export function startPushToTalk(handlers: PttHandlers): boolean {
  stopPushToTalk()
  if (process.platform === 'darwin') return startMacPushToTalk(handlers)
  const devices = keyboardDevices()
  for (const path of devices) {
    try {
      const stream = createReadStream(path)
      stream.on('error', () => stream.destroy())
      stream.on('data', (chunk) => onChunk(chunk as Buffer, handlers))
      streams.push(stream)
    } catch {
      /* device not readable — skip it */
    }
  }
  if (streams.length === 0) {
    console.log('[ptt] no readable keyboard device; hold-to-talk unavailable')
    return false
  }
  console.log(`[ptt] hold-to-talk active on ${streams.length} keyboard device(s)`)
  return true
}

function onChunk(chunk: Buffer, handlers: PttHandlers): void {
  for (let off = 0; off + EVENT_SIZE <= chunk.length; off += EVENT_SIZE) {
    const type = chunk.readUInt16LE(off + 16)
    if (type !== EV_KEY) continue
    const code = chunk.readUInt16LE(off + 18)
    if (!WATCHED.has(code)) continue // never inspect any other key
    const value = chunk.readInt32LE(off + 20)
    if (value === 2) continue // auto-repeat: the key is already down

    const down = value === 1
    if (CTRL.has(code)) held.ctrl = down
    else if (ALT.has(code)) held.alt = down
    else if (code === KEY_SPACE) held.space = down

    const complete = held.ctrl && held.alt && held.space
    if (complete && !chordActive) {
      chordActive = true
      handlers.onPress()
    } else if (!complete && chordActive) {
      chordActive = false
      handlers.onRelease()
    }
  }
}

/**
 * macOS hold-to-talk, via the helper's listen-only event tap.
 *
 * There is no evdev here, and Electron's globalShortcut only ever fires on key-DOWN,
 * so without a second source of key-up the dictation hotkey can only be a toggle. The
 * helper watches the Fn/🌐 key (flagsChanged, keycode 63) with a passive CGEventTap
 * and writes "down"/"up". If the user has System Settings → Keyboard → "Press 🌐 key
 * to" set to Dictation/Emoji, that system action fires too — "Do Nothing" is the
 * clean configuration.
 *
 * NSEvent's global monitor would have been simpler and does not work: Cocoa withholds
 * keyUp from it while Command is held, so the release for a ⌘-chord never arrives and
 * recording would never stop.
 *
 * Requires Accessibility. Returns false without it, and the caller falls back to the
 * toggle rather than losing dictation entirely.
 */
function startMacPushToTalk(handlers: PttHandlers): boolean {
  const path = helperPath()
  if (!path) return false
  try {
    // --fn: hold the Fn/🌐 key. A single held key beats a chord for push-to-talk,
    // and it frees ⌘⇧D to stay as the toggle fallback.
    const child = spawn(path, ['ptt', '--fn'], { stdio: ['pipe', 'pipe', 'ignore'] })
    macChild = child
    child.stdout.setEncoding('utf8')
    let buffered = ''
    child.stdout.on('data', (chunk: string) => {
      buffered += chunk
      const lines = buffered.split('\n')
      buffered = lines.pop() ?? ''
      for (const line of lines) {
        if (line.trim() === 'down') handlers.onPress()
        else if (line.trim() === 'up') handlers.onRelease()
      }
    })
    child.on('error', () => {
      macChild = null
    })
    child.on('exit', (code) => {
      macChild = null
      // Exit 3 is "no Accessibility permission" — expected before the user grants it,
      // and not worth an error every launch.
      if (code !== 0 && code !== 3) console.error(`[ptt] helper ptt exited (${code})`)
    })
    console.log('[ptt] hold-to-talk active (macOS event tap)')
    return true
  } catch (err) {
    console.error('[ptt] could not start the macOS event tap:', err)
    return false
  }
}

let macChild: ChildProcess | null = null

export function stopPushToTalk(): void {
  for (const s of streams) s.destroy()
  streams = []
  held = { ctrl: false, alt: false, space: false }
  chordActive = false
  if (macChild) {
    macChild.kill()
    macChild = null
  }
}

export function isPushToTalkActive(): boolean {
  return streams.length > 0 || macChild !== null
}
