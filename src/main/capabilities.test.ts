import { describe, it, expect } from 'vitest'
import { capabilitiesFor, type Capability, type CapabilityReport } from './capabilities'

/**
 * Pins the linux and darwin answers. A change to a row here should be deliberate.
 */
const states = (r: CapabilityReport): Record<Capability, string> =>
  Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.state])) as Record<Capability, string>

describe('capabilitiesFor', () => {
  it('linux is frozen', () => {
    expect(states(capabilitiesFor('linux'))).toEqual({
      pasteInjection: 'supported',
      holdToTalk: 'supported',
      primarySelection: 'supported',
      screenshotRegion: 'supported',
      localTranscribe: 'supported',
      // xprop only sees X11/Xwayland windows; a natively-Wayland app is misreported.
      sourceApp: 'degraded',
      concealedFormatHints: 'supported',
      autostart: 'supported',
      pinAcrossWorkspaces: 'supported'
    })
  })

  it('darwin is frozen', () => {
    expect(states(capabilitiesFor('darwin'))).toEqual({
      pasteInjection: 'supported',
      holdToTalk: 'supported',
      // No PRIMARY selection exists; the rewrite hotkey uses the AX selection.
      primarySelection: 'unsupported',
      screenshotRegion: 'supported',
      localTranscribe: 'supported',
      sourceApp: 'supported',
      concealedFormatHints: 'supported',
      autostart: 'supported',
      pinAcrossWorkspaces: 'supported'
    })
  })

  it('gives every capability a reason, on every platform', () => {
    // A state with no reason is the failure this registry exists to prevent: the UI
    // would render a disabled control with nothing next to it explaining why.
    for (const platform of ['linux', 'darwin', 'other'] as const) {
      for (const [cap, info] of Object.entries(capabilitiesFor(platform))) {
        expect(info.reason.length, `${platform}.${cap}`).toBeGreaterThan(10)
      }
    }
  })
})
