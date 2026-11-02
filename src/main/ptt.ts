import { accessSync, constants as fsConstants, readFileSync, watch, type FSWatcher } from 'fs'
import { spawn, type ChildProcess } from 'child_process'
import { helperPath } from './mac/helper'
import { getSettings } from './settings'
import { formatChord, parseChord, parseChordOrDefault, toEvdevChord, type EvdevChord } from '@shared/chord'
import { MACOS, LINUX } from './platform'

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
export type PttMode = 'paste' | 'enhance'

export interface PttHandlers {
  onPress: (mode: PttMode) => void
  onRelease: (mode: PttMode) => void
}

/**
 * One `cat` child per open keyboard, streaming raw input_events to a pipe.
 *
 * Why a process and not fs.read on an fd: an evdev read blocks until a key is
 * pressed, and fs.read runs on libuv's threadpool, so every device parked a pool
 * thread forever. Quitting then hung (Node waits for the pool — a stop sat 90 s
 * before SIGKILL), every re-arm leaked another blocked thread per device, and a
 * closed fd number could be reused while its read was still pending, leaving two
 * pumps on one descriptor. A pipe is polled by the event loop, so nothing blocks,
 * and killing the child interrupts its read.
 */
interface DeviceReader {
  path: string
  child: ChildProcess
}

let readers: DeviceReader[] = []

/** Kept while Linux PTT is armed so a hotplug rescan can start readers itself. */
let armedHandlers: PttHandlers | null = null
let inputWatcher: FSWatcher | null = null
let rescanTimer: NodeJS.Timeout | null = null
let retryTimer: NodeJS.Timeout | null = null
/** Device count last reported, so hotplug only logs when it actually changes. */
let reportedCount = 0

const RESCAN_DEBOUNCE_MS = 500
const RETRY_UNREADABLE_MS = 1000

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
 * the power button would get a reader process that never sees a keystroke.
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
  if (MACOS) return startMacPushToTalk(handlers)
  if (!LINUX) {
    // evdev is a Linux kernel interface. Everything below — /proc/bus/input/devices,
    // /dev/input/eventN, struct input_event — exists nowhere else, so off Linux this
    // silently found no devices and returned false. Saying so out loud matters
    // because the caller uses the return value to decide whether the key-repeat
    // fallback is needed, and that fallback reads GNOME's settings.
    console.log('[ptt] evdev is Linux-only; hold-to-talk unavailable on this platform')
    return false
  }

  const s = getSettings()
  // The primary chord always has a value; the enhance one is opt-in and empty by
  // default, so an unconfigured install watches exactly one.
  const wanted: Array<{ mode: PttMode; raw: string | undefined; required: boolean }> = [
    { mode: 'paste', raw: s.dictateChord, required: true },
    { mode: 'enhance', raw: s.dictateEnhanceChord, required: false }
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
  // The reader child fails asynchronously, long after this loop. Counting spawned
  // readers alone would report "hold-to-talk armed on N devices" even when every
  // open was about to fail with EACCES — the app then disables the hotkey toggle in
  // favour of a PTT that can never fire, and dictation is dead with a reassuring log
  // line. So check readability up front, synchronously, and say so when it fails.
  let failed = 0
  for (const { path } of chordDevices()) {
    const err = unreadable(path)
    if (err) {
      failed++
      console.error(`[ptt] cannot read ${path}: ${err}`)
      continue
    }
    spawnReader(path, handlers)
  }
  if (readers.length === 0) {
    console.log('[ptt] no readable keyboard device; hold-to-talk unavailable')
    if (failed > 0) {
      console.error(
        '[ptt] NO keyboard device is readable — hold-to-talk will never fire. ' +
          'Add your user to the "input" group (sudo usermod -aG input $USER) and log back in.'
      )
    }
    return false
  }
  // Only once armed: the caller has already fallen back to the toggle when we
  // return false, and readers appearing behind its back would double-trigger.
  armedHandlers = handlers
  reportedCount = readers.length
  watchInputDir()
  console.log(
    `[ptt] hold-to-talk armed on ${readers.length} device(s); chords ${watched.map((w) => `${w.mode}=${formatChord(parseChordOrDefault(w.mode === 'paste' ? s.dictateChord : s.dictateEnhanceChord))}`).join(' ')}`
  )
  return true
}

/**
 * Only devices that can actually produce a watched chord.
 *
 * We used to open every node with a kbd handler — nine here, including Power
 * Button, Video Bus and two Thelio Io boards that never emit a letter. Back when
 * each device held a blocking read on libuv's four-thread pool, the silent ones
 * parked the whole pool and the real keyboards were never scheduled. Readers no
 * longer block the pool, but there is still no reason to stream a device that can
 * never send the chord, so this keeps it to the two or three real keyboards.
 */
function chordDevices(): KbdDevice[] {
  return keyboardDevices().filter((d) => watched.some((w) => d.keys.has(w.chord.key)))
}

/** The errno code if we cannot read `path`, else null. */
function unreadable(path: string): string | null {
  try {
    accessSync(path, fsConstants.R_OK)
    return null
  } catch (err) {
    return (err as NodeJS.ErrnoException).code ?? String(err)
  }
}

function spawnReader(path: string, handlers: PttHandlers): void {
  const child = spawn('cat', [path], { stdio: ['ignore', 'pipe', 'pipe'] })
  const reader: DeviceReader = { path, child }
  readers.push(reader)

  // A pipe chunk need not end on a record boundary, so carry the partial tail
  // into the next chunk and only ever parse whole 24-byte events.
  let rest: Buffer = Buffer.alloc(0)
  child.stdout.on('data', (chunk: Buffer) => {
    const buf = rest.length > 0 ? Buffer.concat([rest, chunk]) : chunk
    const whole = buf.length - (buf.length % EVENT_SIZE)
    if (whole > 0) onChunk(buf.subarray(0, whole), handlers)
    rest = Buffer.from(buf.subarray(whole))
  })
  // cat only writes its own errors here ("Permission denied", "No such device"),
  // never key data, so it is safe to keep for the exit log.
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (s: string) => {
    if (stderr.length < 512) stderr += s
  })

  // Drop the reader as soon as it dies rather than leaving it listed: a stale
  // entry keeps isPushToTalkActive() reporting a device that is gone (an unplugged
  // keyboard), which suppresses the key-repeat fallback and takes dictation down
  // with no way back. 'error' and 'exit' can both fire; the first one wins.
  const gone = (code: string | number | null): void => {
    if (!readers.includes(reader)) return // torn down by stopPushToTalk, or already handled
    readers = readers.filter((r) => r !== reader)
    const why = stderr.trim()
    console.error(`[ptt] ${path} reader exited (${code})${why ? `: ${why}` : ''}`)
  }
  child.on('error', (err: NodeJS.ErrnoException) => gone(err.code ?? String(err)))
  child.on('exit', (code, signal) => gone(code ?? signal))
}

/**
 * Re-scan on hotplug. Without this an unplugged keyboard's reader exits with
 * ENODEV and, when the keyboard comes back as a new eventN node, nothing ever
 * opens it again — push-to-talk stays dead until the app restarts.
 */
function watchInputDir(): void {
  try {
    // persistent: false so the watcher alone never keeps the process alive at quit.
    inputWatcher = watch('/dev/input', { persistent: false }, (_event, filename) => {
      if (!filename || !/^event\d+$/.test(String(filename))) return
      if (rescanTimer) clearTimeout(rescanTimer)
      // A plug or unplug arrives as a burst of nodes; settle once.
      rescanTimer = setTimeout(() => {
        rescanTimer = null
        rescanDevices()
      }, RESCAN_DEBOUNCE_MS)
    })
    inputWatcher.on('error', (err) => {
      console.error(`[ptt] /dev/input watch failed: ${(err as NodeJS.ErrnoException).code ?? String(err)}`)
      inputWatcher?.close()
      inputWatcher = null
    })
  } catch (err) {
    console.error(`[ptt] cannot watch /dev/input: ${(err as NodeJS.ErrnoException).code ?? String(err)}`)
  }
}

/** Start readers for any chord-capable device not already being read. Readers for
 *  vanished devices remove themselves when their child exits. */
function rescanDevices(): void {
  const handlers = armedHandlers
  if (!handlers) return
  const pending: string[] = []
  for (const { path } of chordDevices()) {
    if (readers.some((r) => r.path === path)) continue
    // udev applies the group/ACL a moment after the node appears, so a fresh
    // keyboard is often unreadable on first sight. Give it one more chance.
    if (unreadable(path)) pending.push(path)
    else spawnReader(path, handlers)
  }
  if (retryTimer) clearTimeout(retryTimer)
  retryTimer = null
  if (pending.length > 0) {
    retryTimer = setTimeout(() => {
      retryTimer = null
      if (armedHandlers !== handlers) return
      for (const path of pending) {
        if (readers.some((r) => r.path === path)) continue
        const err = unreadable(path)
        if (err) console.error(`[ptt] cannot read ${path}: ${err}`)
        else spawnReader(path, handlers)
      }
      reportDeviceCount()
    }, RETRY_UNREADABLE_MS)
  }
  reportDeviceCount()
}

function reportDeviceCount(): void {
  if (readers.length === reportedCount) return
  reportedCount = readers.length
  console.log(`[ptt] input devices changed; now reading ${readers.length} device(s)`)
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
    // Every dictation mode is held, not toggled — the same behaviour Linux gets from
    // evdev. The helper watches each chord with one listen-only event tap and reports
    // "<mode> down" / "<mode> up"; globalShortcut cannot do this because it only ever
    // reports key-down, which is why these two modes used to be toggles.
    //
    // ⌘⇧D is watched as well as Fn, so it holds rather than toggles. Every dictation
    // key on macOS then behaves identically to Linux, and no code has to special-case
    // "this one has a release and that one doesn't". Carbon virtual keycodes: D=2, A=0.
    const child = spawn(
      path,
      [
        'ptt',
        '--fn',
        '--watch',
        'paste:2:cmd+shift',
        '--watch',
        'enhance:2:cmd+alt'
      ],
      { stdio: ['pipe', 'pipe', 'ignore'] }
    )
    macChild = child
    child.stdout.setEncoding('utf8')
    let buffered = ''
    child.stdout.on('data', (chunk: string) => {
      buffered += chunk
      const lines = buffered.split('\n')
      buffered = lines.pop() ?? ''
      for (const raw of lines) {
        const line = raw.trim()
        if (!line) continue
        // "<mode> down" / "<mode> up". A bare "down"/"up" means an older helper
        // binary that only knew the Fn key, so treat it as the plain mode rather
        // than dropping the event and silently losing push-to-talk after an upgrade.
        const [a, b] = line.split(/\s+/)
        const mode = (b ? a : 'paste') as PttMode
        const edge = b ?? a
        if (mode !== 'paste' && mode !== 'enhance') continue
        if (edge === 'down') handlers.onPress(mode)
        else if (edge === 'up') handlers.onRelease(mode)
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
  armedHandlers = null
  inputWatcher?.close()
  inputWatcher = null
  if (rescanTimer) clearTimeout(rescanTimer)
  if (retryTimer) clearTimeout(retryTimer)
  rescanTimer = retryTimer = null
  // Empty the list before killing so the exit handlers see a teardown, not a
  // failure, and stay quiet. SIGKILL interrupts the blocked read immediately.
  const open = readers
  readers = []
  reportedCount = 0
  for (const { child } of open) {
    try {
      child.kill('SIGKILL')
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
  return readers.length > 0 || macChild !== null
}
