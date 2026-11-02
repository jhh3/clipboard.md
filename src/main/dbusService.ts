import * as dbus from 'dbus-next'

/**
 * A D-Bus entry point for the global hotkeys.
 *
 * GNOME custom keybindings run a *command*, and they re-run it on key repeat — a
 * held hotkey produced 144 launches in one session, each one a full Electron cold
 * start that immediately exited against the single-instance lock. That made
 * push-to-talk unusable (the HUD flashed open/closed dozens of times a second) and
 * burned a core doing it.
 *
 * So the keybindings now call `gdbus`, a tiny C binary that hands the action
 * straight to the running app. Key repeat becomes cheap enough to be *useful*:
 * it's what tells us the key is still held.
 */

export const DBUS_NAME = 'md.clipboard.app'
export const DBUS_PATH = '/md/clipboard/app'
export const DBUS_IFACE = 'md.clipboard.app.Actions'

export type TriggerHandler = (action: string) => void

/**
 * A held GNOME binding re-fires every ~30 ms after the repeat delay (~500 ms). For
 * every action but dictation, a trigger this soon after the previous one of the
 * same action is that repeat, not a press: holding the palette key used to toggle
 * the palette 30 times a second. The window slides — each repeat extends it — so a
 * hold of any length is one press. Dictation keys pass through untouched: their
 * repeats are the hold signal dictateTrigger reads when evdev is unavailable.
 */
const REPEAT_WINDOW_MS = 650
const lastTrigger = new Map<string, number>()
/** Repeats dropped (or, for dictation, passed) since the last log line, per action. */
const quietRepeats = new Map<string, number>()

export function isRepeat(action: string, now: number): boolean {
  const last = lastTrigger.get(action)
  lastTrigger.set(action, now)
  return last !== undefined && now - last < REPEAT_WINDOW_MS
}

export async function startDbusService(onTrigger: TriggerHandler): Promise<boolean> {
  try {
    const bus = dbus.sessionBus()
    const { Interface } = dbus.interface

    class ActionsInterface extends Interface {
      Trigger(action: string): void {
        const repeat = isRepeat(action, Date.now())
        // Logged because this is the seam every Linux hotkey passes through, and a
        // gdbus call that returns success while nothing happens is otherwise
        // indistinguishable from the action itself silently doing nothing. Only the
        // press is logged: one line per repeat was 78,000 synchronous writes a day.
        if (repeat) {
          quietRepeats.set(action, (quietRepeats.get(action) ?? 0) + 1)
        } else {
          const n = quietRepeats.get(action) ?? 0
          quietRepeats.delete(action)
          console.log(`[dbus] trigger ${action}${n > 0 ? ` (previous hold repeated ${n}x)` : ''}`)
        }
        if (repeat && !action.startsWith('dictate')) return
        try {
          onTrigger(action)
        } catch (err) {
          console.error(`[dbus] handler for ${action} threw:`, err)
        }
      }
    }

    // dbus-next declares members through this decorator-free registration form.
    ActionsInterface.configureMembers({
      methods: {
        Trigger: { inSignature: 's', outSignature: '' }
      }
    })

    const iface = new ActionsInterface(DBUS_IFACE)
    bus.export(DBUS_PATH, iface)
    await bus.requestName(DBUS_NAME, 0)
    console.log(`[dbus] listening on ${DBUS_NAME}${DBUS_PATH}`)
    return true
  } catch (err) {
    // Not fatal: hotkeys fall back to launching the binary with a flag.
    console.error('[dbus] could not export service, hotkeys will use the CLI fallback:', err)
    return false
  }
}
