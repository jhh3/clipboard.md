import { describe, it, expect } from 'vitest'
import { capabilitiesFor, type Capability, type CapabilityReport } from './capabilities'

/**
 * The regression tripwire for the whole Windows port.
 *
 * The hard constraint on this work is that Linux and macOS behaviour does not move.
 * "Behaviour" is hard to snapshot; the DECISION each platform takes is not. Every
 * platform-dependent choice in the port is expressed as a pure function of the
 * platform, and this file pins the linux and darwin answers.
 *
 * If a later step changes a linux or darwin row here, that is not a snapshot to
 * update — it is the review failing, out loud, exactly as intended.
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

  it('does not depend on arch except for local transcription', () => {
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      const x64 = capabilitiesFor(platform, 'x64')
      const arm = capabilitiesFor(platform, 'arm64')
      const diff = (Object.keys(x64) as Capability[]).filter(
        (k) => JSON.stringify(x64[k]) !== JSON.stringify(arm[k])
      )
      expect(diff.every((k) => k === 'localTranscribe')).toBe(true)
    }
  })

  it('never reports ARM64 Windows as able to transcribe locally', () => {
    // sherpa-onnx publishes win-x64 and win-ia32 and no win-arm64 addon at all, so
    // this stays unsupported no matter what the rest of the port does.
    expect(capabilitiesFor('win32', 'arm64').localTranscribe.state).toBe('unsupported')
  })

  it('gives every capability a reason, on every platform', () => {
    // A state with no reason is the failure this registry exists to prevent: the UI
    // would render a disabled control with nothing next to it explaining why.
    for (const platform of ['linux', 'darwin', 'win32', 'other'] as const) {
      for (const [cap, info] of Object.entries(capabilitiesFor(platform))) {
        expect(info.reason.length, `${platform}.${cap}`).toBeGreaterThan(10)
      }
    }
  })
})
