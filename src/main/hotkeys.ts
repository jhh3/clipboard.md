import { app, globalShortcut } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { DBUS_NAME, DBUS_PATH, DBUS_IFACE } from './dbusService'
import { getSettings } from './settings'
import {
  effectiveDictateChord,
  parseChord,
  parseChordOrDefault,
  toAccelerator,
  toGnomeBinding
} from '@shared/chord'
import { MACOS, LINUX, WIN32 } from './platform'

const execFileP = promisify(execFile)

export interface HotkeyActions {
  toggle: () => void
  rewrite: () => void
  screenshot: () => void
  scratchpad: () => void
  /** Push-to-talk dictation: toggles recording (GNOME keybindings can't report key-up). */
  dictate: () => void
  /** Same, but the transcript also goes through an AI cleanup pass. */
  dictateEnhance: () => void
  /** Same recording, but the transcript is spoken to the primary agent. */
  dictateAgent: () => void
  notes: () => void
  agents: () => void
}

/**
 * Hotkey strategy per platform:
 *  - darwin: Electron globalShortcut (reliable).
 *  - linux/GNOME Wayland: globalShortcut is dead (mutter ≥49 killed Xwayland grabs).
 *    We register GNOME custom keybindings that run `<binary> --<action>`; the second
 *    instance hits our single-instance lock and wakes the running app.
 */
/** macOS accelerators, in the order they're reported when registration fails. */
const MAC_SHORTCUTS: Array<[string, keyof HotkeyActions]> = [
  ['Command+Shift+V', 'toggle'],
  ['Command+Shift+R', 'rewrite'],
  ['Command+Shift+S', 'screenshot'],
  ['Command+Shift+E', 'scratchpad'],
  ['Command+Shift+D', 'dictate'],
  // The other two dictation modes. Option rather than Shift: a global shortcut is
  // taken from every app on the machine, and Cmd+Shift+G/T/P are Find-Again,
  // reopen-tab and command-palette in common apps. Cmd+Option+<letter> is far less
  // contested. These are toggles — press to start, press again to stop — because
  // globalShortcut only ever reports key-down; hold-to-talk on macOS is the Fn key.
  ['Command+Alt+D', 'dictateEnhance'],
  ['Command+Alt+A', 'dictateAgent'],
  ['Command+Shift+N', 'notes'],
  ['Command+Shift+A', 'agents']
]

export async function setupHotkeys(actions: HotkeyActions): Promise<void> {
  if (MACOS) {
    // register() returns false when something else already owns the combination —
    // another app, or a system shortcut. Ignoring that return value is how a hotkey
    // ends up "just not working" with nothing anywhere to explain why. macOS has no
    // API to name the owner, so the honest thing is to say which one failed.
    const failed: string[] = []
    for (const [accelerator, action] of MAC_SHORTCUTS) {
      if (!globalShortcut.register(accelerator, actions[action])) failed.push(accelerator)
    }
    if (failed.length > 0) {
      console.error(
        `[hotkeys] could not register ${failed.join(', ')} — another app or a system ` +
          'shortcut already owns them. Change or free the conflicting shortcut.'
      )
    } else {
      console.log(`[hotkeys] registered ${MAC_SHORTCUTS.length} global shortcuts`)
    }
    return
  }
  if (WIN32) {
    setupWindowsHotkeys(actions)
    return
  }
  if (!LINUX) {
    // Explicit, because the alternative is what used to happen: an unknown platform
    // fell through to ensureGnomeKeybindings(), which shells out to `gsettings`,
    // gets ENOENT, and logs "failed to register GNOME keybindings" — naming a
    // desktop environment that is not installed and cannot be.
    console.log('[hotkeys] no hotkey backend on this platform; use the tray')
    return
  }
  await ensureGnomeKeybindings()
}

/**
 * The accelerators Windows registers, and why they are not the Linux ones.
 *
 * Ctrl+Shift, never Ctrl+Alt. On most non-US layouts Ctrl+Alt IS AltGr, so
 * registering Ctrl+Alt+V system-wide silently destroys the user's ability to type
 * `@`, `€` or `ł` EVERYWHERE on the machine for as long as this app runs. That is
 * the only change in this port capable of breaking something outside the app, and it
 * would present as "my keyboard is broken", with nothing pointing here.
 *
 * `rewrite` is absent deliberately. Windows cannot read the current selection (see
 * capabilities.ts), so registering a global Ctrl+Shift+R would take a shortcut away
 * from every other app in exchange for a key that can only ever apologise.
 */
export function windowsShortcuts(settings: {
  dictateChord?: string
  dictateEnhanceChord?: string
  dictateAgentChord?: string
}): Array<[string, keyof HotkeyActions]> {
  const out: Array<[string, keyof HotkeyActions]> = [
    ['Control+Shift+V', 'toggle'],
    ['Control+Shift+S', 'screenshot'],
    ['Control+Shift+E', 'scratchpad'],
    ['Control+Shift+N', 'notes'],
    ['Control+Shift+A', 'agents']
  ]
  // The dictation keys come from settings, exactly as they do on Linux, so the one
  // chord the user can edit stays the one that fires.
  const dictation: Array<[string | undefined, keyof HotkeyActions]> = [
    [effectiveDictateChord(settings.dictateChord, 'win32'), 'dictate'],
    [settings.dictateEnhanceChord, 'dictateEnhance'],
    [settings.dictateAgentChord, 'dictateAgent']
  ]
  for (const [raw, action] of dictation) {
    const chord = parseChord(raw?.trim() ?? '')
    if (!chord) continue // unbound by default; an empty chord registers nothing
    const accel = toAccelerator(chord)
    if (!accel) {
      console.error(`[hotkeys] "${raw}" cannot be expressed as an Electron accelerator; ${action} not bound`)
      continue
    }
    out.push([accel, action])
  }
  return out
}

/** Failures the UI can show. A packaged Windows app has no console to print to. */
let hotkeyFailures: string[] = []

export function hotkeyRegistrationFailures(): string[] {
  return hotkeyFailures
}

function setupWindowsHotkeys(actions: HotkeyActions): void {
  // Re-registering without this leaves the old accelerators bound to the old
  // closures, so editing a chord in Settings adds a second live hotkey.
  globalShortcut.unregisterAll()
  hotkeyFailures = []
  const wanted = windowsShortcuts(getSettings())
  for (const [accelerator, action] of wanted) {
    let ok = false
    try {
      ok = globalShortcut.register(accelerator, actions[action])
    } catch (err) {
      // register() THROWS on an accelerator it cannot parse and RETURNS FALSE on one
      // that is taken. Both must be reported, and only the second is the user's to fix.
      console.error(`[hotkeys] ${accelerator} is not a valid accelerator:`, err)
    }
    if (!ok) hotkeyFailures.push(accelerator)
  }
  if (hotkeyFailures.length > 0) {
    // RegisterHotKey is first-come-first-served on Windows, so a conflict can appear
    // on one boot and not the next depending on what started first. Surfaced in
    // Settings as well as logged, because a packaged app here has no console at all
    // and "the shortcut just stopped working" is otherwise unexplainable.
    console.error(
      `[hotkeys] could not register ${hotkeyFailures.join(', ')} — another running app already ` +
        'owns them. Windows grants a hotkey to whoever asks first; close the other app or ' +
        'change the shortcut.'
    )
  }
  console.log(`[hotkeys] registered ${wanted.length - hotkeyFailures.length}/${wanted.length} global shortcuts`)
}

interface Binding {
  slug: string
  name: string
  binding: string
  arg: string
  /** Defaults we shipped previously — safe to migrate away from, unlike a user rebind. */
  previous?: string[]
  /**
   * Settings owns this binding, so always write it — never treat the existing value
   * as a user rebind to preserve.
   *
   * Only the dictate chord sets this, and it has to. The chord is now editable in our
   * own Settings, and evdev is reprogrammed from it immediately; if the GNOME side
   * were left alone as a "user rebind", changing the chord would move the observer
   * and not the trigger, which is precisely the drift shared/chord.ts exists to stop.
   * The cost is that rebinding this one entry in GNOME's own control centre gets
   * overwritten — correct, because our Settings is where it belongs now.
   */
  authoritative?: boolean
}

const BINDINGS: Binding[] = [
  { slug: 'clipboard-md', name: 'clipboard.md — palette', binding: '<Control><Alt>v', arg: '--toggle' },
  { slug: 'clipboard-md-rewrite', name: 'clipboard.md — rewrite selection', binding: '<Control><Alt>r', arg: '--rewrite' },
  { slug: 'clipboard-md-shot', name: 'clipboard.md — screenshot', binding: '<Control><Alt>s', arg: '--capture' },
  { slug: 'clipboard-md-scratch', name: 'clipboard.md — scratchpad', binding: '<Control><Alt>e', arg: '--scratchpad' },
  {
    slug: 'clipboard-md-dictate',
    name: 'clipboard.md — dictate (hold to talk)',
    // Derived from settings.dictateChord, NOT hardcoded: ptt.ts watches the evdev
    // codes for the same chord, and the two must agree or dictation degrades
    // silently. See shared/chord.ts.
    //
    // Ctrl+Alt+D was the original default and is GNOME's built-in "show desktop" —
    // it hid every window. Space is also far nicer to hold for push-to-talk.
    get binding() {
      return toGnomeBinding(parseChordOrDefault(getSettings().dictateChord))
    },
    arg: '--dictate',
    previous: ['<Control><Alt>d'],
    authoritative: true
  },
  {
    slug: 'clipboard-md-dictate-enhance',
    name: 'clipboard.md — dictate and enhance (AI)',
    // Second dictation key: same recording flow, but the transcript is additionally
    // sent to a model for the corrections a regex cannot make (self-corrections,
    // ambiguous fillers, tone). Kept on its OWN key rather than a setting on the main
    // one, so the default dictation path stays offline and predictable — you opt into
    // the network per utterance, by choosing which button to hold.
    //
    // No default binding: an empty chord registers nothing, so this costs a user who
    // never configures it exactly nothing and cannot collide with their shortcuts.
    get binding() {
      const chord = parseChord(getSettings().dictateEnhanceChord ?? '')
      return chord ? toGnomeBinding(chord) : ''
    },
    arg: '--dictate-enhance',
    authoritative: true
  },
  {
    slug: 'clipboard-md-dictate-agent',
    name: 'clipboard.md — dictate to agent',
    // Third dictation key: record exactly as normal, then hand the transcript to the
    // primary agent instead of pasting it. Unbound by default, same as the AI key.
    get binding() {
      const chord = parseChord(getSettings().dictateAgentChord ?? '')
      return chord ? toGnomeBinding(chord) : ''
    },
    arg: '--dictate-agent',
    authoritative: true
  },
  { slug: 'clipboard-md-notes', name: 'clipboard.md — notes', binding: '<Control><Alt>n', arg: '--notes' },
  { slug: 'clipboard-md-agents', name: 'clipboard.md — agent inbox', binding: '<Control><Alt>a', arg: '--agents' }
]

const LIST_KEY = 'org.gnome.settings-daemon.plugins.media-keys custom-keybindings'

async function gsettings(args: string[]): Promise<string> {
  const { stdout } = await execFileP('gsettings', args)
  return stdout.trim()
}

export async function ensureGnomeKeybindings(): Promise<boolean> {
  try {
    const current = await gsettings(['get', ...LIST_KEY.split(' ')])
    const list: string[] = current === '@as []' ? [] : JSON.parse(current.replace(/'/g, '"'))
    let changed = false
    for (const b of BINDINGS) {
      const path = `/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/${b.slug}/`
      if (!list.includes(path)) {
        list.push(path)
        changed = true
      }
    }
    if (changed) {
      await gsettings(['set', ...LIST_KEY.split(' '), '[' + list.map((p) => `'${p}'`).join(', ') + ']'])
    }
    const launch = app.isPackaged
      ? `"${process.execPath}"`
      : `"${process.execPath}" "${app.getAppPath()}"`
    for (const b of BINDINGS) {
      const schema = `org.gnome.settings-daemon.plugins.media-keys.custom-keybinding:/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/${b.slug}/`
      const key = schema.split(' ')
      // Command/name are ours to own — the binding is not. If the user rebound it,
      // leave their choice alone; only write the default when it's unset or still
      // matches what we last wrote. (We were clobbering rebinds on every launch.)
      const current = (await gsettings(['get', ...key, 'binding']).catch(() => "''")).replace(
        /^'|'$/g,
        ''
      )
      // Prefer gdbus (a few ms) over launching Electron (~1-3s, and GNOME re-runs
      // the command on every key repeat). Fall back to the binary if the app isn't
      // running yet, so a cold hotkey press still starts it.
      const action = b.arg.replace(/^--/, '')
      const gdbus =
        `gdbus call --session --dest ${DBUS_NAME} --object-path ${DBUS_PATH} ` +
        `--method ${DBUS_IFACE}.Trigger ${action}`
      const command = `sh -c '${gdbus} >/dev/null 2>&1 || ${launch} ${b.arg}'`
      await gsettings(['set', ...key, 'name', b.name])
      await gsettings(['set', ...key, 'command', command])
      // Write the default only when the slot is empty, already ours, or still holds
      // a default we used to ship (so a bad pick can be corrected). A binding the
      // user chose themselves is never touched.
      const ours = !current || current === '@as []' || current === b.binding
      const staleDefault = (b.previous ?? []).includes(current)
      if (b.authoritative || ours || staleDefault) {
        if (staleDefault) console.log(`[hotkeys] migrating ${b.slug}: ${current} -> ${b.binding}`)
        await gsettings(['set', ...key, 'binding', b.binding])
      } else {
        console.log(`[hotkeys] keeping user binding for ${b.slug}: ${current}`)
      }
    }
    return true
  } catch (err) {
    console.error('[hotkeys] failed to register GNOME keybindings:', err)
    return false
  }
}

/** Every CLI flag that maps to an action — keep in sync with routeArgs. */
export const ACTION_FLAGS = BINDINGS.map((b) => b.arg)

export interface KeyRepeat {
  /** Milliseconds held before the first repeat. */
  delay: number
  /** Milliseconds between repeats after that. */
  interval: number
  /** False when the user has turned key repeat off — then there is no hold signal. */
  enabled: boolean
}

/**
 * The desktop's key-repeat timing, READ rather than assumed.
 *
 * GNOME re-runs a custom keybinding's command on every key repeat, which is the only
 * hold signal available when evdev is unreadable. A previous attempt hardcoded a
 * 350ms gap to detect "still held" — but the real repeat delay here is 500ms, so the
 * first repeat always looked like a deliberate second press and recording stopped
 * immediately. The numbers differ per machine and per user, so they have to be read.
 *
 * Falls back to the GNOME defaults if gsettings is unavailable.
 */
export async function keyRepeatTiming(): Promise<KeyRepeat> {
  const fallback: KeyRepeat = { delay: 500, interval: 30, enabled: true }
  if (!LINUX) return fallback
  const read = async (key: string, dflt: number): Promise<number> => {
    try {
      const out = await gsettings(['get', 'org.gnome.desktop.peripherals.keyboard', key])
      // gsettings prints the TYPE first: "uint32 500". Matching the first digit run
      // returns 32 — from "uint32" — which is a plausible-looking millisecond value
      // and therefore a bug that hides. Take the trailing number.
      const n = Number(/(\d+)\s*$/.exec(out.trim())?.[1])
      return Number.isFinite(n) && n > 0 ? n : dflt
    } catch {
      return dflt
    }
  }
  try {
    const enabled = (await gsettings(['get', 'org.gnome.desktop.peripherals.keyboard', 'repeat']))
      .trim()
      .endsWith('true')
    return {
      delay: await read('delay', fallback.delay),
      interval: await read('repeat-interval', fallback.interval),
      enabled
    }
  } catch {
    return fallback
  }
}

/** Route a second-instance argv to the matching action. */
export function routeArgs(argv: string[], actions: HotkeyActions): void {
  // --background is a session-start launch: stay resident, show nothing.
  if (argv.includes('--background')) return
  if (argv.includes('--rewrite')) actions.rewrite()
  else if (argv.includes('--capture')) actions.screenshot()
  else if (argv.includes('--scratchpad')) actions.scratchpad()
  else if (argv.includes('--dictate-enhance')) actions.dictateEnhance()
  else if (argv.includes('--dictate-agent')) actions.dictateAgent()
  else if (argv.includes('--dictate')) actions.dictate()
  else if (argv.includes('--notes')) actions.notes()
  else if (argv.includes('--agents')) actions.agents()
  else actions.toggle()
}

export function teardownHotkeys(): void {
  globalShortcut.unregisterAll()
}
