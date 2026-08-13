import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import {
  applyDowngrades,
  capabilitiesFor,
  downgradeCapability,
  resetDowngrades,
  type Capability,
  type CapabilityInfo,
  type CapabilityReport
} from './capabilities'

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

  it('matches the contract CI holds the shipped Windows build to', () => {
    // The same file .github/workflows/windows.yml diffs the installed exe's --doctor
    // output against. Checking it from here too means a Windows capability cannot be
    // changed on a Linux machine without the contract being updated in the same
    // commit — you find out in `pnpm test`, not twenty minutes into CI.
    const expected = JSON.parse(readFileSync('.github/expected-capabilities.win32.json', 'utf8'))
    expect(states(capabilitiesFor('win32', 'x64'))).toEqual(expected)
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

  it('stays pure when a downgrade is recorded, so the CI contract still holds', () => {
    // The contract file is diffed against the SHIPPED build's --doctor output. If a
    // runtime downgrade could reach capabilitiesFor(), a managed Windows box with
    // AppLocker would fail the build instead of telling its user something useful.
    const before = states(capabilitiesFor('win32', 'x64'))
    downgradeCapability('concealedFormatHints', { state: 'unsupported', reason: 'sidecar blocked' })
    try {
      expect(states(capabilitiesFor('win32', 'x64'))).toEqual(before)
    } finally {
      resetDowngrades()
    }
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

/**
 * "What this platform can do" and "what this run of it got" are not the same thing.
 *
 * Windows reads password managers' concealed-content markers through a PowerShell
 * sidecar, and Add-Type is blocked outright under Constrained Language Mode,
 * AppLocker and several EDR products — common on exactly the managed machines where
 * a clipboard manager quietly storing every password would go unnoticed. The polling
 * fallback cannot see those markers at all, so the registry has to stop claiming it.
 */
describe('applyDowngrades', () => {
  const blocked: CapabilityInfo = { state: 'unsupported', reason: 'sidecar blocked by AppLocker' }

  it('replaces only the row that was downgraded', () => {
    const base = capabilitiesFor('win32', 'x64')
    const got = applyDowngrades(base, new Map([['concealedFormatHints', blocked]]))
    expect(got.concealedFormatHints).toEqual(blocked)
    for (const key of Object.keys(base) as Capability[]) {
      if (key !== 'concealedFormatHints') expect(got[key]).toEqual(base[key])
    }
  })

  it('returns the table itself when nothing was downgraded', () => {
    const base = capabilitiesFor('linux')
    expect(applyDowngrades(base, new Map())).toBe(base)
  })

  it('does not mutate the table it was given', () => {
    // capabilitiesFor() builds a fresh object per call today; if that ever becomes a
    // cached constant, a mutating overlay would poison every later reader.
    const base = capabilitiesFor('win32', 'x64')
    applyDowngrades(base, new Map([['concealedFormatHints', blocked]]))
    expect(base.concealedFormatHints.state).toBe('supported')
  })
})
