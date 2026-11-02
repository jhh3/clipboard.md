import type { Platform } from './platform'
import { currentPlatform } from './platform'

/**
 * What this platform can actually do — declared once, in public.
 *
 * The alternative, and the reason this file exists, is a feature that is present in
 * the UI and dead in the implementation, failing SILENTLY. Each capability resolves
 * to a state and a reason here, and Settings renders the reason next to the control.
 *
 * This is a PURE function of the platform, so capabilities.test.ts can pin the Linux
 * and macOS rows from any machine.
 */

export type CapabilityState = 'supported' | 'degraded' | 'unsupported'

export type Capability =
  /** Pressing the paste keystroke into the app the user was last using. */
  | 'pasteInjection'
  /** Dictation that records while a key is HELD and stops on release. */
  | 'holdToTalk'
  /** Reading the current selection (X11 PRIMARY, or the platform's equivalent). */
  | 'primarySelection'
  /** Interactive drag-a-rectangle screen capture. */
  | 'screenshotRegion'
  /** Offline transcription (Parakeet via sherpa-onnx). */
  | 'localTranscribe'
  /** Naming the application a clip was copied FROM — what makes the ignore list real. */
  | 'sourceApp'
  /** Password managers' "don't record this" clipboard markers. */
  | 'concealedFormatHints'
  /** Starting with the session, so the hotkeys don't pay an Electron cold start. */
  | 'autostart'
  /** Keeping the palette visible on whichever workspace/desktop the user is on. */
  | 'pinAcrossWorkspaces'

export interface CapabilityInfo {
  state: CapabilityState
  /**
   * Why — in words a user can act on, not an implementation note. This string is
   * rendered in Settings, so "not implemented" is never enough on its own: say what
   * happens instead.
   */
  reason: string
}

export type CapabilityReport = Record<Capability, CapabilityInfo>

const ok = (reason: string): CapabilityInfo => ({ state: 'supported', reason })
const meh = (reason: string): CapabilityInfo => ({ state: 'degraded', reason })
const no = (reason: string): CapabilityInfo => ({ state: 'unsupported', reason })

export function capabilitiesFor(platform: Platform): CapabilityReport {
  switch (platform) {
    case 'linux':
      return {
        pasteInjection: ok('XDG RemoteDesktop portal injects Ctrl+V (one-time permission dialog).'),
        holdToTalk: ok('evdev reports real key up/down, so the dictation chord holds rather than toggles.'),
        primarySelection: ok('X11 PRIMARY selection, read off the UI thread via xclip.'),
        screenshotRegion: ok('XDG Screenshot portal (the shell’s own region picker).'),
        localTranscribe: ok('Parakeet via sherpa-onnx; ffmpeg decodes the recording.'),
        sourceApp: meh(
          'Read from _NET_ACTIVE_WINDOW, which only tracks X11/Xwayland windows — a natively-Wayland app is reported as whichever X11 window was focused last.'
        ),
        concealedFormatHints: ok('x-kde-passwordManagerHint targets are honoured.'),
        autostart: ok('XDG autostart entry in ~/.config/autostart.'),
        pinAcrossWorkspaces: ok('setVisibleOnAllWorkspaces is honoured by mutter.')
      }
    case 'darwin':
      return {
        pasteInjection: ok('The Swift helper posts ⌘V once Accessibility is granted.'),
        holdToTalk: ok('The helper’s listen-only event tap reports key up/down for 🌐 and every dictation chord.'),
        primarySelection: no(
          'macOS has no PRIMARY selection. The rewrite hotkey reads the real selection through the accessibility API instead.'
        ),
        screenshotRegion: ok('screencapture -i (the system crosshair).'),
        localTranscribe: ok('Parakeet via sherpa-onnx; AVFoundation decodes the recording.'),
        sourceApp: ok('NSWorkspace frontmost application, with its bundle id.'),
        concealedFormatHints: ok('org.nspasteboard.ConcealedType and friends are honoured.'),
        autostart: ok('Login item via app.setLoginItemSettings.'),
        pinAcrossWorkspaces: ok('setVisibleOnAllWorkspaces makes the palette follow you across Spaces.')
      }
    default: {
      const why = `${platform} is not a supported platform.`
      return {
        pasteInjection: no(why),
        holdToTalk: no(why),
        primarySelection: no(why),
        screenshotRegion: no(why),
        localTranscribe: no(why),
        sourceApp: no(why),
        concealedFormatHints: no(why),
        autostart: no(why),
        pinAcrossWorkspaces: no(why)
      }
    }
  }
}

/** The report for the machine we are running on, this boot. */
export function capabilities(): CapabilityReport {
  return capabilitiesFor(currentPlatform())
}

export function supports(cap: Capability): boolean {
  return capabilities()[cap].state !== 'unsupported'
}
