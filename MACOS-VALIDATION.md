# macOS Validation & Build-out — Agent Handoff Document

*Audience: a coding agent running on a Mac with this repo checked out. Linux development
happens elsewhere; this doc is the authoritative list of what macOS needs built, validated,
or fixed. Keep it updated — check items off with notes, add discovered issues.*

## Context

clipboard.md is an Electron clipboard manager (see `DESIGN.md`). All platform-specific code
is behind adapters; the macOS adapters are written blind on Linux and need real-hardware
validation. The macOS strategy is "solved territory" (Maccy/Kerlig patterns) — nothing here
is research, it's verification and one small native helper.

## 1. Build & run

- [ ] `pnpm install` succeeds on macOS (arm64): better-sqlite3 rebuild via
      `electron-builder install-app-deps`, sqlite-vec prebuilt `.dylib` loads.
- [ ] `pnpm dev` launches; palette renders.
- [ ] `pnpm test` — all green.

## 2. Capture (src/main/capture/darwin.ts)

- [ ] Polling adapter detects text and image copies within ~500ms.
- [ ] Image capture: PNG/TIFF flavors convert correctly; thumbnails generated.
- [ ] Password-manager conventions honored: copy from a password manager that sets
      `org.nspasteboard.ConcealedType` → item must be skipped or stored masked
      (check `filters.ts` receives the flavor list).
- [ ] Source app captured via `NSWorkspace.frontmostApplication` (may need small addition
      to the Swift helper — see §4).

## 3. Hotkeys & palette

- [ ] Electron `globalShortcut` registers default summon hotkey (Cmd+Shift+V) and fires
      when other apps are focused.
- [ ] Palette shows at cursor position (`screen.getCursorScreenPoint()` + `setPosition`).
- [ ] Palette window type: verify it takes keyboard focus without activating the app's
      dock presence (`app.dock.hide()` + panel-style window; compare Maccy feel).

## 4. Swift helper (needs to be BUILT on the Mac — src/native/mac/)

A single small Swift CLI (`clipmd-helper`) with subcommands, spawned by the main process:

- `paste` — post CGEvent Cmd+V to the frontmost app. Requires Accessibility
  (`AXIsProcessTrustedWithOptions` with prompt). This is the Maccy pattern
  (github.com/p0deje/Maccy discussion #980).
- `frontmost` — print frontmost app bundle id + name (for source-app tracking).
- `selected-text` — the SelectedTextKit chain: AX `kAXSelectedTextAttribute` →
  menu-bar Copy action → simulated Cmd+C with pasteboard backup/restore + muted alert.
- `changecount` (optional) — print NSPasteboard changeCount for cheaper polling.

Validation:
- [ ] Helper compiles (swiftc, no Xcode project needed; universal binary optional for now).
- [ ] Accessibility permission prompt attributes to the right responsible process
      (in dev it may attribute to Electron/terminal — note behavior; in packaged+signed
      builds it must attribute to clipboard.md.app).
- [ ] `item:paste` end-to-end: pick item in palette → lands in previously-focused app.
- [ ] `selected-text` works in: native app (Notes), browser (Safari/Chrome), Electron app
      (VS Code), terminal. Record which fall back to Cmd+C simulation.
- [ ] Secure Input: with a password field focused, paste/selected-text degrade gracefully
      (no hang, clear error).

## 5. Paste-back focus dance

- [ ] After palette hides (`app.hide()`), focus returns to the previous app before the
      CGEvent fires (add small delay if needed; record the reliable delay).

## 5.5 New since first draft (all landed on Linux — validate on macOS)

- [ ] **ModelPort**: Agent SDK + Codex SDK subscription lanes work on the Mac's logins
      (`~/.claude/.credentials.json`, `~/.codex/auth.json`); OpenAI/Gemini via env keys.
- [ ] **Enrichment**: background auto-title/tags/class; image OCR+describe via vision.
- [ ] **Embeddings**: utilityProcess worker (onnxruntime-node arm64) downloads
      bge-small on first run; hybrid search returns.
- [ ] **Hotkeys**: ⌘⇧V palette, ⌘⇧R rewrite, ⌘⇧S screenshot (`screencapture -i` needed
      on macOS — portal path is Linux-only, adapt `capture:screenshot`), ⌘⇧E scratchpad.
- [ ] **Selection rewrite**: macOS needs the Swift helper's selected-text chain
      (AX → Cmd+C fallback) instead of PRIMARY; `rewrite` action in hotkeys.ts.
- [ ] **Scratchpad dictation**: mic permission prompt (NSMicrophoneUsageDescription is
      in electron-builder.yml), MediaRecorder → OpenAI transcription.
- [ ] **Image auto-redact**: tesseract.js + sharp on arm64.
- [ ] **Packaging**: `pnpm build:mac` produces a dmg; asarUnpack list covers native deps.

## 6. Later milestones (skip until Linux side ships them)

- [ ] Apple Vision OCR via `@cherrystudio/mac-system-ocr` in a child process (offline OCR
      path; memory-growth caveat — must run in utilityProcess, not main).
- [ ] Packaging: electron-builder dmg, hardened runtime, entitlements for Accessibility,
      signing + notarization (needs Developer ID).
- [ ] sherpa-onnx CoreML build for transcription.

## Known risks to watch

- Electron ABI vs better-sqlite3: if `pnpm dev` crashes on module version mismatch, run
  `node_modules/.bin/electron-rebuild -f -w better-sqlite3`.
- MAS is off the table (CGEvent flows violate Guideline 2.4.5) — distribution is direct
  download; don't burn time on sandbox entitlements.
- If `globalShortcut` needs media-key style combos, those require Accessibility trust.

## Report format

Append a dated section below with: environment (macOS version, chip, Electron version),
checklist results, fixes committed (with SHAs), and anything that needs Linux-side changes.

---

*No validation runs recorded yet.*
