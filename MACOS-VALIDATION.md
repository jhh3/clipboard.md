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

*No macOS validation runs recorded yet.*
