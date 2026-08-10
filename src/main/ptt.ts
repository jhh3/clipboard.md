import { closeSync, openSync, read as fsRead, readFileSync } from 'fs'
import { spawn, type ChildProcess } from 'child_process'
import { helperPath } from './mac/helper'
import { getSettings } from './settings'
import { formatChord, parseChordOrDefault, toEvdevChord, type EvdevChord } from '@shared/chord'

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
 * only the handful of keycodes in the dictation chord, never buffer or log key data,
 * and never look at any other key. Nothing here is written to disk or sent
 * anywhere. It also degrades silently: if the device can't be opened (no
 * permission), push-to-talk is simply unavailable and the hotkey toggle remains.
 */

// Linux input-event-codes.h
const EV_KEY = 1

/**
 * The chord to watch, derived from settings.dictateChord via shared/chord.ts — the
 * same definition that produces the GNOME binding, so the trigger and the observer
 * cannot disagree. Null until startPushToTalk runs.
 */
let chord: EvdevChord | null = null
/** Which of the chord's modifier groups are currently held, by group index. */
let modsHeld: boolean[] = []
let keyHeld = false

// struct input_event on 64-bit: __kernel_ulong_t sec, usec (8+8), __u16 type,
// __u16 code, __s32 value.
const EVENT_SIZE = 24

export interface PttHandlers {
  onPress: () => void
  onRelease: () => void
}

let fds: number[] = []
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
interface KbdDevice {
  path: string
  /** Keycodes the device advertises, from its KEY bitmap. */
  keys: Set<number>
}

/**
 * Decode a `B: KEY=` bitmap into the keycodes a device can emit.
 *
 * Words are 64-bit hex, printed most-significant first, so the LAST word holds
 * keycodes 0-63. Without this we cannot tell a keyboard from a power button, and
 * opening the power button costs a blocking read on one of libuv's four threads.
 */
function keyBitmap(block: string): Set<number> {
  const out = new Set<number>()
  const m = /B: KEY=([0-9a-fA-F ]+)/.exec(block)
  if (!m) return out
  const words = m[1].trim().split(/\s+/)
  for (let i = 0; i < words.length; i++) {
    const word = BigInt(`0x${words[words.length - 1 - i]}`)
    for (let bit = 0; bit < 64; bit++) {
      if ((word >> BigInt(bit)) & 1n) out.add(i * 64 + bit)
    }
  }
  return out
}

function keyboardDevices(): KbdDevice[] {
  try {
    return readFileSync('/proc/bus/input/devices', 'utf8')
      .split('\n\n')
      .filter((block) => /Handlers=[^\n]*\bkbd\b/.test(block))
      .map((block) => {
        const node = /(event\d+)/.exec(block)?.[1]
        return node ? { path: `/dev/input/${node}`, keys: keyBitmap(block) } : null
      })
      .filter((d): d is KbdDevice => !!d)
  } catch {
    return []
  }
}

/**
 * Start watching for the configured dictation chord. Returns false when no keyboard
 * device could be opened, so the caller can fall back to the toggle.
 *
 * Call again to re-arm after the chord changes in Settings — it tears down first.
 */
export function startPushToTalk(handlers: PttHandlers): boolean {
  stopPushToTalk()
  if (process.platform === 'darwin') return startMacPushToTalk(handlers)

  const parsed = parseChordOrDefault(getSettings().dictateChord)
  chord = toEvdevChord(parsed)
  if (!chord) {
    console.error(`[ptt] chord "${formatChord(parsed)}" has no evdev mapping; hold-to-talk off`)
    return false
  }
  modsHeld = chord.modifierGroups.map(() => false)
  keyHeld = false

  // Count devices we can actually READ, not ones we attempted to open.
  //
  // createReadStream is lazy: a device we lack permission for fails asynchronously
  // via 'error', long after this loop. Counting pushed streams therefore reported
  // "hold-to-talk active on N devices" even when every single open was about to fail
  // with EACCES — the app then disabled the hotkey toggle in favour of a PTT that
  // could never fire, and dictation was dead with a reassuring log line. Track the
  // failures and say so.
  // Only devices that can actually produce this chord.
  //
  // We used to open every node with a kbd handler — nine here, including Power
  // Button, Video Bus and two Thelio Io boards that never emit a letter. Each open
  // device holds a BLOCKING read on a libuv worker thread, and libuv ships four of
  // them, so the silent devices parked the entire pool and the real keyboards were
  // never scheduled. Push-to-talk was dead with fds open, no error and nothing
  // logged, and every isolated probe "worked" only because it opened fewer than four
  // devices. Filtering to devices that advertise the chord's own keycode keeps this
  // to the two or three real keyboards, and the pool bump below covers the rest.
  const devices = keyboardDevices().filter((d) => d.keys.has(chord!.key))
  let failed = 0
  for (const { path } of devices) {
    try {
      const fd = openSync(path, 'r')
      fds.push(fd)
      const buf = Buffer.allocUnsafe(EVENT_SIZE * 64)
      const pump = (): void => {
        if (!fds.includes(fd)) return // torn down by stopPushToTalk
        fsRead(fd, buf, 0, buf.length, null, (err, bytes) => {
          if (err) {
            console.error(`[ptt] ${path} read failed: ${(err as NodeJS.ErrnoException).code}`)
            return
          }
          if (bytes > 0) onChunk(buf.subarray(0, bytes), handlers, path)
          pump()
        })
      }
      pump()
    } catch (err) {
      failed++
      console.error(`[ptt] cannot read ${path}: ${(err as NodeJS.ErrnoException).code ?? String(err)}`)
    }
  }
  if (fds.length === 0) {
    console.log('[ptt] no readable keyboard device; hold-to-talk unavailable')
    if (failed > 0) {
      console.error(
        '[ptt] NO keyboard device is readable — hold-to-talk will never fire. ' +
          'Add your user to the "input" group (sudo usermod -aG input $USER) and log back in.'
      )
    }
    return false
  }
  console.log(
    `[ptt] hold-to-talk armed on ${fds.length} keyboard device(s); chord ${formatChord(parsed)}`
  )
  return true
}

function onChunk(chunk: Buffer, handlers: PttHandlers, _path = '?'): void {
  const c = chord
  if (!c) return
  for (let off = 0; off + EVENT_SIZE <= chunk.length; off += EVENT_SIZE) {
    const type = chunk.readUInt16LE(off + 16)
    if (type !== EV_KEY) continue
    const code = chunk.readUInt16LE(off + 18)
    if (!c.watched.has(code)) continue // never inspect any other key
    const value = chunk.readInt32LE(off + 20)
    if (value === 2) continue // auto-repeat: the key is already down

    const down = value === 1
    if (code === c.key) keyHeld = down
    // A modifier may appear in only one group, but check them all rather than
    // assuming: left and right variants both satisfy their group.
    c.modifierGroups.forEach((group, i) => {
      if (group.includes(code)) modsHeld[i] = down
    })

    const complete = keyHeld && modsHeld.every(Boolean)
    if (complete && !chordActive) {
      chordActive = true
      console.log('[ptt] chord PRESS from evdev')
      handlers.onPress()
    } else if (!complete && chordActive) {
      chordActive = false
      console.log('[ptt] chord RELEASE from evdev')
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
  const open = fds
  fds = []
  for (const fd of open) {
    try {
      closeSync(fd)
    } catch {
      /* already gone */
    }
  }
  modsHeld = modsHeld.map(() => false)
  keyHeld = false
  chordActive = false
  if (macChild) {
    macChild.kill()
    macChild = null
  }
}

export function isPushToTalkActive(): boolean {
  return fds.length > 0 || macChild !== null
}
