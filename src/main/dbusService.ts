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

export async function startDbusService(onTrigger: TriggerHandler): Promise<boolean> {
  try {
    const bus = dbus.sessionBus()
    const { Interface } = dbus.interface

    class ActionsInterface extends Interface {
      Trigger(action: string): void {
        // Logged because this is the seam every Linux hotkey passes through, and a
        // gdbus call that returns success while nothing happens is otherwise
        // indistinguishable from the action itself silently doing nothing.
        console.log(`[dbus] trigger ${action}`)
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
