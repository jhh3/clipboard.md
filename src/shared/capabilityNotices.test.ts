import { describe, it, expect } from 'vitest'
import { capabilityNotices } from './capabilityNotices'
import { capabilitiesFor } from '../main/capabilities'

/**
 * The Settings pane on macOS and Linux is not allowed to change.
 *
 * The registry describes every platform, so a notice list filtered on
 * `state !== 'supported'` and nothing else rendered on macOS too — one line about
 * PRIMARY selection, a mechanism macOS never had and that the rewrite hotkey does
 * not use there. The real capability tables are fed through the real selector here,
 * so this stays true as rows are added: mark anything degraded on linux or darwin
 * and the check below still passes only because the platform gate holds.
 */
describe('capabilityNotices', () => {
  for (const platform of ['darwin', 'linux'] as const) {
    it(`shows nothing on ${platform}, whatever the registry says`, () => {
      const caps = capabilitiesFor(platform)
      // Sanity: these platforms really do have non-'supported' rows, so the empty
      // result below is the gate working and not an empty input.
      expect(Object.values(caps).some((c) => c.state !== 'supported')).toBe(true)
      expect(capabilityNotices(caps, platform)).toEqual([])
    })
  }

  it('shows the narrow Windows v1 set on win32', () => {
    const notices = capabilityNotices(capabilitiesFor('win32', 'x64'), 'win32')
    expect(notices.map((n) => n.key).sort()).toEqual([
      'holdToTalk',
      'localTranscribe',
      'pasteInjection',
      'pinAcrossWorkspaces',
      'primarySelection',
      'screenshotRegion'
    ])
    // The reason is the whole value of the row — a state with no explanation sends
    // the user looking for a setting that does not exist.
    for (const n of notices) expect(n.reason.length).toBeGreaterThan(0)
  })

  it('says nothing on a platform it does not know', () => {
    expect(capabilityNotices(capabilitiesFor('other'), 'other')).toEqual([])
  })
})
