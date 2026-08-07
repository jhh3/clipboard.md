# macOS Build-out & Validation — Agent Handoff

**Audience:** a coding agent working on a Mac with this repo checked out.
**Status:** the Linux (Ubuntu 26.04 / GNOME 50 Wayland) side is working end-to-end.
macOS code paths exist but have **never run on real hardware**. Your job is to make
them real, fix what's broken, and report back.

Read `DESIGN.md` first — especially §2 "Platform ground truth" and its
**"Hard-won rules (do not regress these)"**. Those rules were paid for painfully on
Linux; several have direct macOS analogues.

---

## 0. Orientation

- Electron 43 + TypeScript + React 19, `electron-vite`. `pnpm install && pnpm dev`.
- One SQLite file (better-sqlite3 + FTS5 + sqlite-vec) at `app.getPath('userData')/data`.
- Platform-specific code is deliberately isolated:
  - `src/main/capture/` — clipboard watching + read/write helpers
  - `src/main/paste.ts` — paste delivery (injection vs copy+notify)
  - `src/main/hotkeys.ts` — global shortcuts
  - `src/main/windows.ts` — window creation/placement
  - `src/main/transcribe.ts` — dictation (local Parakeet + cloud fallback)
- Everything else (store, enrichment, ModelPort, renderer) is platform-neutral and
  should need no changes.

### The macOS-shaped holes (known, expected)

| Area | Current state on macOS | What's needed |
|---|---|---|
| Paste injection | `paste.ts` shells out to `<resourcesPath>/clipmd-helper paste` — **this binary does not exist yet** | Build the Swift helper (§2) |
| Selected-text capture (rewrite hotkey) | Falls back to `clipboard.readText()`, i.e. the wrong text | AX-based `selected-text` in the helper |
| Screenshot | `capture:screenshot` calls the **XDG portal — Linux-only** | Branch to `screencapture -i` |
| Clipboard read/write | Native Electron path (correct for macOS — no X11 hazards) | Verify only |
| Window placement | Placement logic runs (not gated off like Wayland) | Verify multi-display behaviour |

---

## 1. Build & baseline

- [ ] `pnpm install` on arm64: `better-sqlite3` rebuilds, `sqlite-vec` `.dylib` loads,
      `onnxruntime-node` and `sharp` resolve arm64 binaries.
- [ ] `pnpm test` green (store-layer tests are platform-neutral).
- [ ] `pnpm typecheck` clean.
- [ ] `pnpm dev` launches; palette appears; capture a few text clips and confirm they
      show up in the palette list.
- If Electron/better-sqlite3 ABI mismatch: `node_modules/.bin/electron-rebuild -f -w better-sqlite3`.

## 2. The Swift helper (the main build task)

Create `src/native/mac/clipmd-helper.swift` → a single universal binary that the main
process spawns. `paste.ts` already expects `paste`; the rest are new subcommands.

- `paste` — activate the previous app, post CGEvent ⌘V. Requires Accessibility
  (`AXIsProcessTrustedWithOptions`). This is the Maccy pattern (Maccy #980 / #161).
- `frontmost` — print frontmost app bundle id + localized name → source-app tracking.
- `selected-text` — the SelectedTextKit chain: AX `kAXSelectedTextAttribute` →
  menu-bar Copy → simulated ⌘C with pasteboard backup/restore and the alert sound
  muted. Print the selection to stdout.
- `changecount` (optional) — print `NSPasteboard.general.changeCount` so the capture
  poll is cheap.

Wire-up checklist:
- [ ] Helper builds (`swiftc`, universal via `-target arm64-apple-macos12 -target x86_64-...`).
- [ ] Bundled into `resourcesPath` by electron-builder (`extraResources`) and marked executable.
- [ ] `item:paste` end-to-end: pick an item, it lands in the previously focused app.
- [ ] Accessibility prompt appears once and attributes to **clipboard.md.app** in a
      signed build (in `pnpm dev` it may attribute to Electron/terminal — note behaviour).
- [ ] `selected-text` verified in: Notes (native), Safari, Chrome, VS Code (Electron),
      Terminal. Record which fall back to the ⌘C path.
- [ ] Secure Input (password field focused): both paste and selected-text degrade
      gracefully — no hang, clear error, no repeated prompts.
- [ ] `hotkeys.ts` `rewrite` action: replace the Linux PRIMARY read with the helper's
      `selected-text` on darwin.

## 3. Hotkeys & windows

Electron `globalShortcut` works on macOS (unlike GNOME). Registered in `hotkeys.ts`:
⌘⇧V palette · ⌘⇧R rewrite · ⌘⇧S screenshot · ⌘⇧E scratchpad · ⌘⇧D dictate.

- [ ] All five fire while other apps are focused.
- [ ] Palette shows at the cursor's display and takes keyboard focus.
- [ ] `app.dock.hide()` / panel behaviour: the palette shouldn't add a Dock icon or
      steal app activation. Compare against Maccy's feel.
- [ ] Aux windows (settings/scratchpad) open on a sensible display, are draggable, and
      remember position. **Note:** the Wayland guard (`WAYLAND` const in `windows.ts`)
      is false on macOS, so the placement/persistence code path is live here — this is
      the path that was never exercised on Linux. Watch multi-display + Spaces.
- [ ] After a paste, focus returns to the target app before the CGEvent fires; record
      the delay that is reliable (Linux uses 150ms).

## 4. Screenshot (needs a macOS branch)

`ipc.ts → capture:screenshot` currently calls `portalScreenshot()` (Linux-only).
- [ ] Branch on darwin to `screencapture -i -c` (interactive → clipboard) or
      `screencapture -i <tmpfile>` then `capture.ingestImageFile(path)` — the latter
      matches the Linux flow and avoids a clipboard round trip.
- [ ] Screen Recording permission prompt handled with a clear explainer.

## 5. Dictation & transcription

- [ ] Mic permission: `NSMicrophoneUsageDescription` is already in `electron-builder.yml`;
      confirm the prompt appears and the HUD records.
- [ ] Cloud transcription (`gpt-4o-mini-transcribe`) works.
- [ ] Local transcription: `transcribe.ts` downloads Parakeet TDT (~490MB) and runs it
      through `sherpa-onnx-node`. Verify the **arm64 binary** resolves
      (`sherpa-onnx-darwin-arm64`) and that `ffmpeg` is available — it is **assumed on
      PATH** and macOS does not ship it. Either bundle a static ffmpeg or decode webm
      via AVFoundation in the helper. **This is a real gap, not a nit.**
- [ ] Verified working on Linux: webm → ffmpeg → sherpa → text in ~1.1s.

## 6. AI providers

Should be platform-neutral, but confirm:
- [ ] Claude Agent SDK picks up `~/.claude/.credentials.json`; Codex SDK picks up
      `~/.codex/auth.json`; both also accept API keys.
- [ ] Image enrichment (vision) produces OCR text + tags for a screenshot clip.
- [ ] Local embeddings: the `utilityProcess` worker loads `bge-small` via
      onnxruntime-node arm64, and semantic search returns hits.

## 7. Packaging

- [ ] `pnpm build:mac` produces a dmg.
- [ ] `asarUnpack` covers all native deps (better-sqlite3, sqlite-vec, sharp, @img,
      onnxruntime-node, tesseract.js, the Agent SDK) — plus the Swift helper via
      `extraResources`.
- [ ] Hardened runtime + entitlements for Accessibility/microphone; signing and
      notarization need a Developer ID.
- [ ] **MAS is off the table** — CGEvent-based paste violates Guideline 2.4.5.
      Distribution is direct download; don't spend time on sandbox entitlements.
- [ ] Autostart: Linux writes `~/.config/autostart/*.desktop` (`src/main/autostart.ts`).
      Add the macOS equivalent (`app.setLoginItemSettings({ openAtLogin: true })`).

## 8. Report back

Append a dated section below with: macOS version + chip, Electron version, checklist
results, commits (SHAs), anything that needed changes on the shared/Linux side, and
anything you could not verify. If you change shared code, re-run `pnpm test` and
`pnpm typecheck` and say so.

---

## 2026-08-07 — first run on real hardware

**Machine:** macOS 26.5.2 (25F84), Apple M2 Pro, arm64, single built-in display.
**Electron:** 43.2.0 (unchanged). **Node:** v22.18.0. **pnpm:** 10.18.0 (now pinned).
**Build verified:** both `pnpm dev` and a packaged `dist/mac-arm64/clipboard.md.app`.

Branch `macos-buildout`. Every claim below says how it was checked. Anything not
listed under "Verified" was **not** verified — see §Could not verify.

### Commits

| SHA | What |
|---|---|
| `bc217ed` | Pin pnpm 10 — the workspace config was being silently ignored |
| `736cbfd` | Add the macOS side-car helper (paste, AX selection, frontmost, audio decode) |
| `51626a0` | Wire macOS to the helper: paste, selection, source app, screenshot, audio |
| `9219a6f` | macOS window behaviour, packaging and login item |
| `5f5cd27` | Report global-shortcut registration failures instead of swallowing them |
| `f308935` | Make macOS capture event-driven instead of polling the whole pasteboard |
| `efc23b1` | Fix three bugs that only appear in a packaged build |

### The blocker nobody expected: install was broken

`pnpm install` **failed outright** on a clean checkout (exit 7). `pnpm-workspace.yaml`
is written in pnpm 10 syntax but nothing pinned the package manager, so pnpm 9.4 read
neither `overrides` nor the build allowlist: the `usocket: '-'` override never applied,
and pnpm 9 injected its own bundled node-gyp 7.1.2, which assigns to a `process.config`
that Node 22 freezes → `TypeError: Cannot assign to read only property 'cflags'`.
Fixed by adding `packageManager`. Also renamed `allowBuilds:` (not a pnpm key — every
listed package had its install script skipped) to `onlyBuiltDependencies:`.

### Verified

**Baseline** — clean `pnpm install` on arm64; better-sqlite3 rebuilds for Electron 43;
sqlite-vec, onnxruntime-node, sharp and sherpa-onnx all resolve `darwin-arm64` binaries.
`pnpm test` 64 passing (3 added). `pnpm typecheck` clean. `pnpm build:mac` produces a
428MB dmg.

**Swift helper** (`src/native/mac/clipmd-helper.swift`, built by `build.sh`) — universal
`arm64 + x86_64`, verified with `lipo -archs`; the script now asserts both slices,
because `swiftc` honours only the *last* `-target` and two of them silently yields a
single-arch binary (it did: the first build was x86_64-only).

- `frontmost` → `WezTerm\tcom.github.wez.wezterm`. Captured clips now record
  `source_app` ("Google Chrome") — it was `NULL` for everything before.
- `paste` → **5/5** ⌘V landed in a real NSTextView.
- `selected-text` tier 1 (AX) → correct text, **~25ms** steady state, pasteboard
  `changeCount` unchanged (non-destructive).
- `selected-text` tier 2 (menu-bar Copy) → correct text, **73ms**, user's clipboard
  restored intact.
- Worst case (all three tiers run, real ⌘C posted): the user's clipboard content is
  **preserved**. Checked explicitly with a sentinel.
- Nothing selected → clean failure, no hang. 1576ms → 561ms after using a greyed-out
  Copy item as proof of "no selection".
- `decode-audio` → aiff, m4a/AAC and wav decode to 16k mono. **WebM/Opus does not** —
  "no audio track" — which is why the renderer had to change.
- `watch` → emits a baseline then exactly one line per change; **0.0% CPU, 1.6MB RSS**
  idle; exits when stdin closes, no stray process left behind.

**Three bugs found by measuring, not reading** (all would have shipped):

1. Posting a CGEvent and exiting immediately **drops the keystroke** — the window
   server delivers asynchronously and a short-lived CLI dies first. 0ms drain: 0/3
   pastes landed. 5ms: 3/3. Now 30ms.
2. `kAXSelectedText` on the **system-wide** element returns nothing for a background
   CLI caller. Tier 1 would never have fired; every rewrite would have silently paid
   for a destructive pasteboard round trip. Per-application element works.
3. The capture loop re-encoded the whole clipboard **every 400ms**: 55.7ms per poll
   with a screenshot on the pasteboard (~14% of a core, indefinitely, on the main
   thread). Now event-driven via the helper's `watch`.

**Packaged build** — helper at `Contents/Resources/clipmd-helper`, executable,
universal. `LSUIElement` true; Accessibility/Screen-Recording/microphone usage strings
present; entitlements applied. All native modules unpacked from the asar.
sqlite-vec **loads** (the `CREATE VIRTUAL TABLE … USING vec0` succeeded) and
embeddings are written — 3 clips → 3 vectors. Capture reports
`event-driven (pasteboard watcher); polling disabled`. 5/5 global shortcuts register.
Zero errors in the log.

**Three more bugs that only exist when packaged** (all invisible in `pnpm dev`):

1. **Semantic search was dead on macOS.** `electron-builder.yml` pruned
   `onnxruntime-node/bin/napi-v6/{darwin,win32}/**` from the *top-level* `files` list,
   which every target shares — so the macOS build deleted the binding the macOS app
   loads. Now pruned per-platform.
2. **Both subscription lanes failed on every request** with `spawn ENOTDIR`: the SDKs
   derived their CLI path from inside `app.asar`, which is a file, so `spawn` got
   ENOTDIR. Now resolved to the unpacked path explicitly.
3. **Background embedding stopped ~5s after every launch** — platform-neutral, see
   below.

**Dictation decode chain** — proven end to end without a mic: Chromium's own
MediaRecorder `audio/mp4;codecs=mp4a.40.2` output (5436 bytes) → helper AVFoundation
decode → 1.06s of 16k mono WAV. This is the ffmpeg replacement, closed.

### Could not verify — needs a human at the keyboard

Be sceptical of anything here; none of it was watched working.

- **Multi-display and Spaces.** Only one display is attached to this machine, so the
  flagged risk area is *unverified*. The placement code was changed (cursor's display
  rather than primary) and reviewed, but never exercised across monitors, and the
  saved-bounds restore path was never tested with a display unplugged.
- **Anything requiring GUI automation.** Driving another app needs Automation TCC
  permission, whose prompt cannot be answered headlessly — it hung the session once.
  So `selected-text` was validated against a purpose-built AppKit harness
  (`src/native/mac/axprobe.swift`), **not** against Notes, Safari, Chrome, VS Code or
  Terminal. Which of those fall back to which tier is still an open question.
- **The palette as a user sees it** — that it appears, takes keyboard focus, filters,
  and pastes on Enter. Only the main-process side was exercised.
- **`item:paste` end to end** through the UI, and the hide → focus-return → ⌘V timing
  in the real flow. The helper's half is solid (5/5); the sequencing is not proven.
- **Secure Input.** Confirmed *off* during testing (`IsSecureEventInputEnabled()`), so
  the degradation path with a password field focused was never exercised.
- **Accessibility prompt attribution.** The build is unsigned (`identity: null`), so
  whether the grant attaches to clipboard.md.app rather than a helper — DESIGN.md §6
  open item 5 — remains open. In dev it attributes to the terminal.
- **The interactive screenshot picker.** `screencapture -x` full-screen works and
  Screen Recording is granted to the terminal, but `-i` (the picker the app uses) and
  the app's own permission prompt were not driven.
- **Dictation as a feature** — mic permission prompt, the HUD, and Parakeet actually
  transcribing. Only the decode step is proven. The ~490MB model was never downloaded.
- **Cloud/subscription AI providers.** `spawn ENOTDIR` is fixed and no longer logs, but
  no successful enrichment response was observed.
- **Autostart.** `setLoginItemSettings` is wired and now guarded to packaged builds; a
  real login cycle was not tested.

### Changes that affect Linux — please re-check

- `package.json` `packageManager` + `onlyBuiltDependencies` — changes how *every*
  machine installs.
- **`embeddings/index.ts` idle-unload bug is platform-neutral** and almost certainly
  affects Linux identically: `lastUse` started at 0, so the first drain killed the
  worker 5s after launch, and `drainEmbeddings()` then returned early forever because
  `worker` was null. Nothing captured after that was ever embedded. Worth confirming
  how much of the Linux history actually has vectors.
- `filters.ts` gained an optional `sourceAppId` (absent on Linux → byte-identical
  behaviour, 3 new tests). `capture/index.ts` and `sourceApp.ts` now pass `{name, id}`
  instead of a bare string.
- `ipc.ts` / `index.ts` call `takeScreenshot()`, a passthrough to `portalScreenshot()`
  on Linux. `paste.ts`'s 150ms Linux focus-settle is now a named constant, same value.
- Autostart now only registers from a packaged build — on Linux too.
- `electron-builder.yml`: the onnxruntime exclusion moved under `linux:` unchanged.

### Still open

- `tracks(withMediaType:)` in the helper is deprecated since macOS 13; kept because
  the async replacement would raise the baseline above macOS 12.
- Signing and notarization need a Developer ID; nothing here is signed.
- No app icon is set (`default Electron icon is used`).
