import { app, globalShortcut } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { DBUS_NAME, DBUS_PATH, DBUS_IFACE } from './dbusService'
import { getSettings } from './settings'
import { parseChord, parseChordOrDefault, toGnomeBinding, toPortalTrigger } from '@shared/chord'
import { MACOS, LINUX } from './platform'

const execFileP = promisify(execFile)

export interface HotkeyActions {
  toggle: () => void
  rewrite: () => void
  screenshot: () => void
  /** Push-to-talk dictation: toggles recording (GNOME keybindings can't report key-up). */
  dictate: () => void
  /** Same, but the transcript also goes through an AI cleanup pass. */
  dictateEnhance: () => void
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
  ['Command+Shift+D', 'dictate'],
  // The AI-cleanup dictation mode. Option rather than Shift: a global shortcut is
  // taken from every app on the machine, and Cmd+Shift+G/T/P are Find-Again,
  // reopen-tab and command-palette in common apps. Cmd+Option+<letter> is far less
  // contested. These are toggles — press to start, press again to stop — because
  // globalShortcut only ever reports key-down; hold-to-talk on macOS is the Fn key.
  ['Command+Alt+D', 'dictateEnhance']
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
 * The dictation keys as GlobalShortcuts portal requests, keyed by dictation mode.
 *
 * Same settings and same defaults as the GNOME bindings and the evdev observer, so
 * the three can never be watching different chords. Unbound modes are left out.
 */
export function portalDictationShortcuts(settings: {
  dictateChord?: string
  dictateEnhanceChord?: string
}): Array<{ id: 'paste' | 'enhance'; description: string; trigger: string }> {
  const wanted = [
    { id: 'paste' as const, chord: parseChordOrDefault(settings.dictateChord), description: 'Dictate (hold to talk)' },
    { id: 'enhance' as const, chord: parseChord(settings.dictateEnhanceChord?.trim() ?? ''), description: 'Dictate and enhance with AI (hold to talk)' }
  ]
  return wanted
    .filter((w): w is typeof w & { chord: NonNullable<typeof w.chord> } => w.chord !== null)
    .map((w) => ({ id: w.id, description: w.description, trigger: toPortalTrigger(w.chord) }))
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
  }
]

const LIST_KEY = 'org.gnome.settings-daemon.plugins.media-keys custom-keybindings'

/**
 * Bindings for features that no longer exist. Left registered they keep grabbing
 * their chords (Ctrl+Alt+E/N/A) from every other app, so they are taken off the list.
 */
const RETIRED_SLUGS = [
  'clipboard-md-scratch',
  'clipboard-md-dictate-agent',
  'clipboard-md-notes',
  'clipboard-md-agents'
]

/** The dictation keys, which hold to talk and so are the ones GNOME auto-repeats. */
export const DICTATION_FLAGS = ['--dictate', '--dictate-enhance'] as const
export type DictationFlag = (typeof DICTATION_FLAGS)[number]

/**
 * Dictation keys something else already delivers, so GNOME must not bind them.
 *
 * A held GNOME custom keybinding runs its command on every key repeat, and each run
 * becomes a transient systemd scope — ~18,000 dead scopes in a few days, systemd
 * --user pinned at ~100% CPU. Once the GlobalShortcuts portal owns a chord, or evdev
 * has proven it sees that chord's press and release, the GNOME binding is pure cost,
 * so it is written empty. Until then it stays: it is the only trigger on machines
 * with neither.
 */
const handledElsewhere = new Set<DictationFlag>()

/** Mark which dictation keys are delivered without GNOME. True when that changed. */
export function setDictationHandledElsewhere(flags: Iterable<DictationFlag>): boolean {
  const next = new Set(flags)
  const changed =
    next.size !== handledElsewhere.size || [...next].some((f) => !handledElsewhere.has(f))
  handledElsewhere.clear()
  for (const f of next) handledElsewhere.add(f)
  return changed
}

/** The binding GNOME should hold for this entry: empty when it is handled elsewhere. */
export function gnomeBindingFor(arg: string, binding: string): string {
  return (handledElsewhere as Set<string>).has(arg) ? '' : binding
}

async function gsettings(args: string[]): Promise<string> {
  const { stdout } = await execFileP('gsettings', args)
  return stdout.trim()
}

/**
 * Rewrite our GNOME keybindings. Calls are serialized and coalesced: one rewrite is
 * ~30 gsettings spawns, and startup used to fire several at once (setup, the portal
 * grant, evdev proving a chord), interleaving their writes so a stale run could
 * land last and put a dictation binding back. Now at most one runs, and any number
 * of requests made meanwhile collapse into a single follow-up with the latest state.
 */
let gnomeRun: Promise<boolean> | null = null
let gnomeAgain = false
export function ensureGnomeKeybindings(): Promise<boolean> {
  if (gnomeRun) {
    gnomeAgain = true
    return gnomeRun
  }
  gnomeRun = (async () => {
    let ok = await writeGnomeKeybindings()
    while (gnomeAgain) {
      gnomeAgain = false
      ok = await writeGnomeKeybindings()
    }
    return ok
  })().finally(() => {
    gnomeRun = null
  })
  return gnomeRun
}

async function writeGnomeKeybindings(): Promise<boolean> {
  try {
    const current = await gsettings(['get', ...LIST_KEY.split(' ')])
    const parsed: string[] = current === '@as []' ? [] : JSON.parse(current.replace(/'/g, '"'))
    const retired = (p: string): boolean => RETIRED_SLUGS.some((slug) => p.endsWith(`/${slug}/`))
    const list = parsed.filter((p) => !retired(p))
    let changed = list.length !== parsed.length
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
        await gsettings(['set', ...key, 'binding', gnomeBindingFor(b.arg, b.binding)])
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
  else if (argv.includes('--dictate-enhance')) actions.dictateEnhance()
  else if (argv.includes('--dictate')) actions.dictate()
  else actions.toggle()
}

export function teardownHotkeys(): void {
  globalShortcut.unregisterAll()
}
