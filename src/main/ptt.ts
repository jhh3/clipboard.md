import { closeSync, openSync, read as fsRead, readFileSync } from 'fs'
import { spawn, type ChildProcess } from 'child_process'
import { helperPath } from './mac/helper'
import { getSettings } from './settings'
import { formatChord, parseChord, parseChordOrDefault, toEvdevChord, type EvdevChord } from '@shared/chord'

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
 * Every chord we watch, derived from settings via shared/chord.ts — the same
 * definitions that produce the GNOME bindings, so trigger and observer cannot
 * disagree.
 *
 * All THREE dictation keys, not just the first. Watching only settings.dictateChord
 * meant evdev reported press and release for the plain key while the AI-polish and
 * agent keys had no observer at all — and once evdev is live the key-repeat fallback
 * is deliberately disabled, so those two started recording with nothing left to stop
 * them. They never stopped listening.
 */
interface WatchedChord {
  mode: PttMode
  chord: EvdevChord
  /** Which of this chord's modifier groups are currently held, by group index. */
  modsHeld: boolean[]
  keyHeld: boolean
  active: boolean
}

let watched: WatchedChord[] = []

// struct input_event on 64-bit: __kernel_ulong_t sec, usec (8+8), __u16 type,
// __u16 code, __s32 value.
const EVENT_SIZE = 24

/** Which dictation key was pressed — they record identically and differ only in
 *  what happens to the transcript. */
export type PttMode = 'paste' | 'enhance' | 'agent'

export interface PttHandlers {
  onPress: (mode: PttMode) => void
  onRelease: (mode: PttMode) => void
}

let fds: number[] = []

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

  const s = getSettings()
  // The primary chord always has a value; the other two are opt-in and empty by
  // default, so an unconfigured install watches exactly one.
  const wanted: Array<{ mode: PttMode; raw: string | undefined; required: boolean }> = [
    { mode: 'paste', raw: s.dictateChord, required: true },
    { mode: 'enhance', raw: s.dictateEnhanceChord, required: false },
    { mode: 'agent', raw: s.dictateAgentChord, required: false }
  ]
  watched = []
  for (const w of wanted) {
    const text = w.raw?.trim()
    if (!text && !w.required) continue
    const parsed = w.required ? parseChordOrDefault(text) : parseChord(text ?? '')
    const evdev = parsed && toEvdevChord(parsed)
    if (!evdev) {
      console.error(`[ptt] ${w.mode} chord "${text ?? ''}" has no evdev mapping; not watched`)
      continue
    }
    watched.push({
      mode: w.mode,
      chord: evdev,
      modsHeld: evdev.modifierGroups.map(() => false),
      keyHeld: false,
      active: false
    })
  }
  if (watched.length === 0) {
    console.error('[ptt] no usable dictation chord; hold-to-talk off')
    return false
  }

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
  const devices = keyboardDevices().filter((d) => watched.some((w) => d.keys.has(w.chord.key)))
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
            // Drop the descriptor rather than abandoning it mid-list: leaving it in
            // `fds` keeps isPushToTalkActive() reporting a device that is gone (an
            // unplugged keyboard), which suppresses the key-repeat fallback and takes
            // dictation down with no way back.
            console.error(`[ptt] ${path} read failed: ${(err as NodeJS.ErrnoException).code}`)
            fds = fds.filter((f) => f !== fd)
            try {
              closeSync(fd)
            } catch {
              /* already gone */
            }
            return
          }
          if (bytes > 0) onChunk(buf.subarray(0, bytes), handlers)
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
    `[ptt] hold-to-talk armed on ${fds.length} device(s); chords ${watched.map((w) => `${w.mode}=${formatChord(parseChordOrDefault(w.mode === 'paste' ? s.dictateChord : w.mode === 'enhance' ? s.dictateEnhanceChord : s.dictateAgentChord))}`).join(' ')}`
  )
  return true
}

function onChunk(chunk: Buffer, handlers: PttHandlers): void {
  if (watched.length === 0) return
  for (let off = 0; off + EVENT_SIZE <= chunk.length; off += EVENT_SIZE) {
    const type = chunk.readUInt16LE(off + 16)
    if (type !== EV_KEY) continue
    const code = chunk.readUInt16LE(off + 18)
    const value = chunk.readInt32LE(off + 20)
    if (value === 2) continue // auto-repeat: the key is already down
    const down = value === 1

    for (const w of watched) {
      if (!w.chord.watched.has(code)) continue // never inspect any other key
      if (code === w.chord.key) w.keyHeld = down
      // A modifier may appear in only one group, but check them all rather than
      // assuming: left and right variants both satisfy their group.
      w.chord.modifierGroups.forEach((group, i) => {
        if (group.includes(code)) w.modsHeld[i] = down
      })

      const complete = w.keyHeld && w.modsHeld.every(Boolean)
      if (complete && !w.active) {
        w.active = true
        console.log(`[ptt] chord PRESS from evdev (${w.mode})`)
        handlers.onPress(w.mode)
      } else if (!complete && w.active) {
        w.active = false
        console.log(`[ptt] chord RELEASE from evdev (${w.mode})`)
        handlers.onRelease(w.mode)
      }
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
        // macOS watches the Fn key only, which is the plain dictation mode. The
        // AI-polish and agent keys are Linux-only for now (see hotkeys.ts).
        if (line.trim() === 'down') handlers.onPress('paste')
        else if (line.trim() === 'up') handlers.onRelease('paste')
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
  watched = []
  if (macChild) {
    macChild.kill()
    macChild = null
  }
}

export function isPushToTalkActive(): boolean {
  return fds.length > 0 || macChild !== null
}
