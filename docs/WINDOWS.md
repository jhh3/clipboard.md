# Windows support

Status: **built and tested by CI, never run by a human.** Everything below was
written on a Linux machine. The parts that can be proved from here are proved by
tests; the parts that cannot are listed at the bottom, and none of them should be
treated as working until somebody has watched them work.

Ask the build itself what it thinks it can do:

```
clipboard.md.exe --doctor
```

That prints the capability registry (`src/main/capabilities.ts`) plus resolved
binary paths as JSON. CI diffs the `capabilities` block against
`.github/expected-capabilities.win32.json` on every push, so this file and the code
cannot drift apart silently.

## What Windows v1 is

Capture, history, search, the palette, the tray, autostart, global hotkeys, region
screenshot, and paste — with the limits below.

| Capability | State | Why |
| --- | --- | --- |
| Clipboard capture | works | `GetClipboardSequenceNumber` sidecar at 250ms, falling back to polling |
| Password-manager suppression | works\* | concealed-content clipboard formats + the exe-name ignore list |
| Paste | limited | `SendInput` after focus is restored; refuses into elevated windows |
| Region screenshot | limited | our own overlay; DRM windows come out black, no cursor |
| Hold-to-talk dictation | limited | press to start, press again to stop |
| Rewrite selection | **not shipped** | Windows has no "current selection" to read |
| Offline transcription | **not shipped** | no ffmpeg to decode; no sherpa build at all on ARM64 |
| Pin across virtual desktops | **not shipped** | not reachable from Electron |

\* structurally complete; see the verification list.

Each of these resolves to a state **and a reason** in the capability registry, and
Settings renders the reasons next to the affected controls. Nothing is left to fail
silently — that was the whole point of the exercise, because the pre-port Windows
behaviour was four features that appeared to work and did nothing.

## Deliberate non-goals for v1

- **A keyboard hook.** Real hold-to-talk needs system-wide key-up, which needs a
  hook, which puts every keystroke on the machine through our process. The privacy
  guarantee at the top of `src/main/ptt.ts` says we do not do that, and shipping a
  hook while leaving that comment in place would make the source a lie. Windows gets
  a documented press/press toggle instead. (Plan step 14 is the opt-in version.)
- **Primary-selection rewrite.** The pre-port code fell back to
  `clipboard.readText()`, which is not a degraded answer to "what is selected" — it
  is a confident answer to a different question, and it would paste a model's
  rewrite of the wrong text over the user's cursor.
- **Local (Parakeet) transcription.** Needs an audio decoder we do not ship. Plan
  step 13 (decode via Web Audio in the renderer) unlocks it, and is its own change
  because it also removes the ffmpeg and AVFoundation paths on Linux and macOS.

## Defaults that differ from Linux, on purpose

Windows hotkeys are **Ctrl+Shift**, never Ctrl+Alt. On most non-US layouts Ctrl+Alt
is AltGr, so a system-wide Ctrl+Alt+V would take away the user's ability to type
`@`, `€` or `ł` in every application for as long as this app runs. It is the only
change in the port capable of breaking something outside the app. The stored setting
is not migrated — `effectiveDictateChord` substitutes at registration time, and only
when the value is still the shipped default, so a profile synced between a Linux and
a Windows machine keeps working on both.

## Building

```
pnpm install        # no compiler needed: every native dep ships win32 prebuilds
pnpm build:win      # electron-vite + electron-builder --win (nsis)
node scripts/verify-package.mjs dist/win-unpacked
```

**Do not cross-build from Linux.** NSIS needs wine, and a Linux checkout has
resolved Linux-only optional dependencies, so the artifact would be missing
`sherpa-onnx-win-x64`, `sqlite-vec-windows-x64` and `@koromix/koffi-win32-x64`
without saying so. `.github/workflows/windows.yml` builds on `windows-latest`.

## Needs a real Windows machine

Nothing here is a known bug. They are claims the code depends on that no test on
this machine can settle.

1. **Excel/Word format precedence.** `pickPayloadKind` assumes Chromium reports
   `image/png` for the `CF_DIB` that Office puts alongside `CF_UNICODETEXT` on an
   ordinary *text* copy. If that assumption is wrong the rule is harmless; if it is
   right and the rule were absent, every Excel copy would be stored as a screenshot
   with the text discarded. Confirm with one Ctrl+C from a spreadsheet.
2. **Password-manager markers.** That 1Password, KeePassXC and Bitwarden actually
   set `ExcludeClipboardContentFromMonitorProcessing` /
   `CanIncludeInClipboardHistory` / `CanUploadToCloudClipboard` on current builds.
   **Treat the suppression as unproven until a real password copy is confirmed
   suppressed on a real box.** Also worth spiking whether Electron's
   `clipboard.readBuffer(<name>)` reaches `RegisterClipboardFormatW`, which would
   let the sidecar drop those three fields.
3. **Paste, end to end.** UIPI against an elevated window, the foreground lock, and
   whether `SetForegroundWindow` + `AttachThreadInput` actually lands.
4. **The terminal matrix.** cmd standalone, powershell standalone, Windows Terminal,
   Git Bash/mintty, one Electron terminal. The rule is inverted from Linux
   (allowlist-only, plain Ctrl+V by default) and getting it wrong makes terminals the
   one place paste silently fails.
5. **globalShortcut on key repeat.** If Electron 43 does not re-fire, the key-repeat
   hold heuristic degrades to a plain toggle — which is what the registry already
   promises, so the failure is bounded, but it should be observed.
6. **Tray.** Icon contrast on a light taskbar, whether left-click and the context
   menu double-fire, and Win11 overflow placement. *Not fixable in code:* Windows 11
   hides new tray icons in the overflow with no promotion API, so for an app whose
   design is "no Dock icon, the tray is the evidence it is running", the tray cannot
   be the only path to the palette.
7. **Virtual desktops.** Where a hidden-then-shown palette lands.
8. **`sherpa-onnx.node` loading its sibling DLLs** from inside `app.asar.unpacked`.
   `verify-package.mjs` asserts the layout; CI's `--doctor` run proves the process
   starts. A load failure here is a hard throw, which is the good case.

## Before the first public build: signing

Unsigned NSIS means SmartScreen blocks first run for **every** user, and unlike
macOS there is no build-it-yourself escape hatch. A background tray process calling
`SendInput` unsigned is also a plausible EDR trigger. This is a distribution
decision (an OV certificate, or Azure Trusted Signing), not an engineering one —
it needs answering before a build is handed to anyone, not after the first report.
