import type { Platform } from './platform'
import { currentPlatform } from './platform'

/**
 * What this platform can actually do — declared once, in public.
 *
 * The alternative, and the reason this file exists, is a feature that is present in
 * the UI and dead in the implementation. Windows shipped four of those the moment
 * `!== 'linux'` sent it down the macOS path: a rewrite hotkey that rewrote the last
 * thing you copied rather than the thing you had selected, a screenshot key that
 * reported "Capture cancelled" for a capture nobody cancelled, an autostart toggle
 * that wrote a `.desktop` file into `%USERPROFILE%\.config` and then reported
 * enabled forever, and a paste that waited 300ms and did nothing.
 *
 * Every one of those is a feature failing SILENTLY, which is strictly worse than a
 * feature that is visibly absent: the user has no way to tell the app is not doing
 * the thing, so they blame their own hands. So each of them now resolves to a state
 * and a reason here, Settings renders the reason next to the control, and `--doctor`
 * prints the whole table.
 *
 * This is a PURE function of the platform (plus arch, for the one capability that
 * depends on it). That is what lets a Linux machine prove the Linux and macOS rows
 * did not move while Windows was being added — see capabilities.test.ts, whose
 * snapshot is the regression tripwire for the whole port.
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
   * rendered in Settings and printed by --doctor, so "not implemented" is never
   * enough on its own: say what happens instead.
   */
  reason: string
}

export type CapabilityReport = Record<Capability, CapabilityInfo>

const ok = (reason: string): CapabilityInfo => ({ state: 'supported', reason })
const meh = (reason: string): CapabilityInfo => ({ state: 'degraded', reason })
const no = (reason: string): CapabilityInfo => ({ state: 'unsupported', reason })

/**
 * `arch` is only consulted for local transcription: sherpa-onnx publishes win-x64
 * and win-ia32 and no win-arm64 addon at all, so ARM64 Windows can never run
 * Parakeet locally however much of the rest of the port lands.
 */
export function capabilitiesFor(platform: Platform, arch: string = process.arch): CapabilityReport {
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
    case 'win32':
      return {
        // Windows v1 deliberately ships the honest, narrow set. Each 'unsupported'
        // below is a feature we could half-implement and choose not to, because a
        // half-implemented one of these is indistinguishable from a broken hand.
        pasteInjection: meh(
          'Ctrl+V is sent with SendInput once the window you were using is back in the foreground. It refuses — and leaves the clip on the clipboard — if focus does not return, or if the target runs as administrator, because Windows blocks input from a lower-integrity process.'
        ),
        holdToTalk: meh(
          'Press to start, press again to stop. Windows global hotkeys only ever report key-down, and reading a real key-up needs a machine-wide keyboard hook — which this app will not install to save you one keypress.'
        ),
        primarySelection: no(
          'Windows has no “current selection” to read, so the rewrite hotkey refuses rather than rewriting whatever you last copied.'
        ),
        screenshotRegion: meh(
          'Our own overlay, captured with desktopCapturer. Protected (DRM) windows come out black and the mouse cursor is not included.'
        ),
        localTranscribe:
          arch === 'arm64'
            ? no('sherpa-onnx publishes no win32-arm64 build, so offline transcription is impossible on ARM64 Windows. Use the OpenAI backend.')
            : no('The recording is decoded with ffmpeg, which Windows does not ship. Use the OpenAI backend.'),
        sourceApp: ok('The foreground window’s process image name (GetForegroundWindow → QueryFullProcessImageNameW).'),
        concealedFormatHints: ok(
          'The ExcludeClipboardContentFromMonitorProcessing / CanIncludeInClipboardHistory / CanUploadToCloudClipboard markers are honoured.'
        ),
        autostart: ok('Registry Run entry via app.setLoginItemSettings. Task Manager ▸ Startup can still switch it off, and the log says so when it has.'),
        pinAcrossWorkspaces: no(
          'Electron cannot pin a window across Windows virtual desktops — the palette appears on the desktop it was last shown on.'
        )
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

/**
 * Capabilities the platform table promises and THIS BOOT did not get.
 *
 * capabilitiesFor() is pure on purpose and must stay that way — it is the frozen
 * contract CI holds the shipped build to. But "what this platform can do" and "what
 * this run of it can do" are not always the same, and the gap is not theoretical:
 * Windows' concealed-content markers are read by a PowerShell sidecar, `Add-Type` is
 * blocked outright under Constrained Language Mode, AppLocker and several EDR
 * products, and the polling fallback we drop to cannot see those markers at all
 * (clipboard.availableFormats() never lists them — they are registered formats with
 * no MIME mapping). Before this, the registry went on reporting concealedFormatHints
 * as 'supported' on a machine that was quietly recording every password copied out
 * of a password manager. Saying so is the whole point of the registry.
 *
 * Deliberately NOT applied to capabilitiesFor(): --doctor calls capabilities() and
 * exits before capture ever starts, so the CI contract still sees the pure table.
 */
const downgrades = new Map<Capability, CapabilityInfo>()

export function downgradeCapability(cap: Capability, info: CapabilityInfo): void {
  const prev = downgrades.get(cap)
  if (prev?.state === info.state && prev.reason === info.reason) return
  downgrades.set(cap, info)
  console.error(`[capabilities] ${cap} is ${info.state} on this boot: ${info.reason}`)
}

/** Overlay the boot's downgrades onto a platform table. Pure, so it can be tested. */
export function applyDowngrades(
  report: CapabilityReport,
  over: ReadonlyMap<Capability, CapabilityInfo>
): CapabilityReport {
  if (over.size === 0) return report
  const out = { ...report }
  for (const [cap, info] of over) out[cap] = info
  return out
}

/** The report for the machine we are running on, this boot. */
export function capabilities(): CapabilityReport {
  return applyDowngrades(capabilitiesFor(currentPlatform()), downgrades)
}

/** Test seam — nothing in the app clears a downgrade, because nothing un-breaks. */
export function resetDowngrades(): void {
  downgrades.clear()
}

export function supports(cap: Capability): boolean {
  return capabilities()[cap].state !== 'unsupported'
}
