import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { registerShortcuts, windowsShortcuts, type HotkeyActions } from './hotkeys'

/**
 * A global shortcut that was not granted is invisible from the inside.
 *
 * Windows' RegisterHotKey is first-come-first-served and tells the loser nothing: the
 * user presses a shortcut the app documents, nothing happens, and there is no way to
 * distinguish that from the app being broken. The list of losses was being collected
 * and thrown away — `hotkeyRegistrationFailures()` had no callers at all, while a
 * comment claimed it was "surfaced in Settings".
 */
describe('registerShortcuts', () => {
  const wanted = windowsShortcuts({}) as Array<[string, keyof HotkeyActions]>

  it('reports the accelerators that were already taken', () => {
    // register() RETURNS FALSE for a shortcut another app owns. This is the one the
    // user can act on: close that app, or change the chord.
    const failed = registerShortcuts(wanted, (accel) => accel !== 'Control+Shift+V')
    expect(failed).toEqual(['Control+Shift+V'])
  })

  it('reports the accelerators that could not be parsed', () => {
    // register() THROWS on an accelerator Electron cannot parse — a different failure
    // with the same consequence, and one an early version let escape as an exception.
    const failed = registerShortcuts(wanted, (accel) => {
      if (accel === 'Control+Shift+S') throw new Error('Invalid accelerator')
      return true
    })
    expect(failed).toEqual(['Control+Shift+S'])
  })

  it('says nothing when every shortcut registered', () => {
    expect(registerShortcuts(wanted, () => true)).toEqual([])
  })

  it('registers each accelerator against its own action', () => {
    const seen: Array<[string, string]> = []
    registerShortcuts(wanted, (accel, action) => {
      seen.push([accel, action])
      return true
    })
    expect(seen).toEqual(wanted)
    expect(seen.length).toBeGreaterThan(4)
  })
})

describe('the failure list reaches the UI', () => {
  const read = (p: string): string => readFileSync(p, 'utf8')

  it('is exposed over IPC and rendered, not just collected', () => {
    // The defect this replaces: a getter with zero callers repo-wide, no IPC channel,
    // no preload surface, and a comment in hotkeys.ts asserting the opposite. A
    // structural check because the alternative is booting Electron — and what went
    // wrong was not a wrong value, it was a missing wire.
    expect(read('src/shared/types.ts')).toContain("'hotkeys:failures'")
    expect(read('src/main/ipc.ts')).toMatch(
      /handle\('hotkeys:failures', \(\) => hotkeyRegistrationFailures\(\)\)/
    )
    const settings = read('src/renderer/src/components/Settings.tsx')
    expect(settings).toContain("invoke('hotkeys:failures')")
    expect(settings).toContain('<HotkeyConflicts />')
  })

  it('does not claim the capability registry carries it', () => {
    // capabilitiesFor() is a pure function of platform and arch and structurally
    // cannot hold a per-boot result; saying it does is how this got lost.
    expect(read('src/main/hotkeys.ts')).not.toMatch(/Surfaced in Settings/)
  })
})
