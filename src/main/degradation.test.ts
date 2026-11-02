import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { capabilitiesFor } from './capabilities'

/**
 * macOS must not walk into a Linux mechanism.
 *
 * The functions these tests cover reach for `xprop`, `gsettings`, `/dev/input`,
 * `ffmpeg` and D-Bus, which exist only on Linux. Calling
 * them here would mean importing Electron, so the guards are asserted structurally
 * instead: the source must contain an explicit platform arm, not an implicit one.
 *
 * A structural assertion is weaker than an execution one, and it is the right
 * strength for this particular hazard: what went wrong was never a wrong VALUE, it
 * was a missing BRANCH.
 */
const read = (p: string): string => readFileSync(p, 'utf8')

describe('no implicit fall-through into Linux mechanisms', () => {
  it('screenshot distinguishes unavailable from cancelled', () => {
    const src = read('src/main/screenshot.ts')
    expect(src).toContain('unavailable')
    // The portal is Linux's; reaching it must be gated, not defaulted to.
    expect(src).toMatch(/if \(LINUX\)[\s\S]*portalScreenshot/)
    // …and imported lazily, so a macOS boot does not load dbus-next.
    expect(src).toContain("await import('./portal')")
  })

  it('both screenshot call sites handle all three outcomes', () => {
    for (const f of ['src/main/ipc.ts', 'src/main/index.ts']) {
      expect(read(f), f).toContain("'unavailable' in shot")
    }
  })

  it('focused-window lookups are gated to Linux in both entry points', () => {
    const src = read('src/main/focusedWindow.ts')
    expect(src.match(/if \(!LINUX\) return/g)?.length).toBe(2)
  })

  it('gsettings is gated to Linux', () => {
    const src = read('src/main/hotkeys.ts')
    const guard = src.indexOf('if (!LINUX)')
    const gnome = src.indexOf('await ensureGnomeKeybindings()')
    expect(guard).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(gnome)
  })

  it('evdev is gated to Linux', () => {
    expect(read('src/main/ptt.ts')).toMatch(/if \(!LINUX\) \{/)
  })

  it('the PRIMARY selection reader returns null rather than the clipboard', () => {
    const src = read('src/main/capture/clipboardIO.ts')
    // `clipboard.readText()` here is not a degraded answer to "what is selected" —
    // it is a confident answer to a different question, and the rewrite hotkey would
    // paste a model's rewrite of the wrong text over the user's cursor.
    expect(src).toMatch(/readPrimarySelection\(\): Promise<string \| null> \{\s*\n\s*if \(!LINUX\) return null/)
  })

  it('the rewrite hotkey refuses when there is no selection to read', () => {
    expect(read('src/main/index.ts')).toContain('if (text === null)')
  })

  it('the model archive is deleted after extraction', () => {
    // 490MB left in userData on every platform, for a file already extracted.
    expect(read('src/main/transcribe.ts')).toMatch(/finally \{[\s\S]*rmSync\([\s\S]*parakeet\.tar\.bz2/)
  })

  it('local transcription refuses up front where it cannot work', () => {
    expect(read('src/main/transcribe.ts')).toContain("if (local.state === 'unsupported') throw new Error(local.reason)")
    expect(capabilitiesFor('linux').localTranscribe.state).toBe('supported')
    expect(capabilitiesFor('darwin').localTranscribe.state).toBe('supported')
  })
})
