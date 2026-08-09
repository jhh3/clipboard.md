# Smart Clipboard Manager — Design Document

*Drafted 2026-08-06 from three research streams (competitive landscape, platform capture mechanics, AI stack) plus live verification on the target machine (Ubuntu 26.04, GNOME Shell 50.1, Wayland).*

## 1. Positioning

The open lane, verified against ~30 existing tools: **nothing combines** Maccy's
keyboard-first speed, Ditto/Pastebot's paste stack, Raycast's OCR-searchable images,
and Kerlig's selection-AI — **and nothing credible serves Linux**. The field is
macOS-only (Maccy, Paste, Pastebot, Kerlig, every AI-clipboard app) or abandoning
Linux (EcoPaste dropped it in v1.0, Jul 2026; PasteBar never had it; CopyQ's Wayland
support is chronically broken, UI dated).

**One-liner:** a local-first, keyboard-first clipboard manager for Linux + macOS that
intelligently indexes everything you copy (OCR, tags, semantic search) and can rewrite
whatever you have highlighted — powered by your existing AI subscriptions or BYOK,
never a subscription of its own.

### Differentiators (little/no competition)
1. **Semantic / natural-language search** over history — "that error message from Tuesday".
2. **OCR + describe + auto-tag on images**, indexed into search (only Raycast Pro does OCR).
3. **AI rewrite of the current selection** (Kerlig pattern) folded into the clipboard manager — nobody does this.
4. **AI transforms of clips** — summarize, translate, table→CSV, reformat, custom prompt templates ("paste as…").
5. **Auto-classification** — code (+language), addresses, meeting links, tracking numbers, secrets → smart collections. Literally nobody does this with AI.
6. **MCP server** exposing history/search to AI agents (only CrossPaste + Pastebot 3 started here).
7. **Linux + macOS parity itself** — with honest Wayland support.
8. **Subscription lane**: use the user's existing Claude Code / Codex subscriptions via headless CLI for zero-marginal-cost background AI.

### Anti-goals (the complaint canon)
- No subscription pricing, no retention caps (the #1 switching drivers in every competitor's reviews).
- No always-on accessibility observation (Grammarly's lag/trust disaster). AI is hotkey-on-demand only.
- No cloud sync v1 (ship late and solid, or never — PastePal's flaky iCloud is a reputation killer).
- No capture-everything ambitions without capture-time filtering (Recall backlash).
- OCR/embedding indexing: opt-in, local-first framing, clearly disclosed.
- Don't clobber system shortcuts. Handle CJK/non-ASCII search. Ship DB export from day one.

## 2. Verified platform ground truth (tested on this machine, 2026-08-06)

| Fact | Status |
|---|---|
| GNOME 50.1 advertises `ext_data_control_manager_v1` / `zwlr_data_control_manager_v1` | **NO — verified absent** via wayland-info. Research claiming mutter ≥49.2 ships it did not hold on real hardware. `wl-paste --watch` hangs. Do not build on data-control. |
| Xwayland clipboard bridge (background X client read/write, no focus) | **YES — verified** (xclip round-trip on `DISPLAY=:0` with mutter's Xwayland auth). Mutter syncs CLIPBOARD + PRIMARY to Xwayland regardless of focus, and this works **from a helper process even when Electron itself is a Wayland client**. |
| X11 XFixes selection-change events | **YES — verified live.** `SelectSelectionInput(root, CLIPBOARD, SetSelectionOwner)` on an independent X connection fires on every change. This is our capture trigger; polling is disabled on Linux. |
| Electron `globalShortcut` on GNOME 50 | Dead (mutter ≥49 killed Xwayland grabs; portal path blocked by electron#51875). Use GNOME custom keybindings → `<binary> --<action>` → `second-instance`. |
| Keystroke injection (paste-back) on GNOME Wayland | **XDG RemoteDesktop portal works** (`NotifyKeyboardKeycode`, `persist_mode=2` + restore token). One permission dialog, once. Fallback: copy + notification. `wtype` unusable (mutter lacks virtual-keyboard); `ydotool` needs uinput setup. |
| **Electron ozone platform** | **Run NATIVE WAYLAND (`ozone-platform-hint=auto`). Do not force x11.** Forcing Xwayland caused wrong-monitor placement, unmovable/janky windows and blurry HiDPI. Electron is Wayland-native by default since 38.2. Under Wayland the compositor owns geometry — `setPosition`/`getCursorScreenPoint` are meaningless, so all placement logic must sit out. |
| **X clipboard ownership** | **Our UI process must NEVER own the X CLIPBOARD selection.** Measured in Xvfb: with Electron as owner and its main thread busy 6s, another app's paste request blocked **5511ms**; with a detached `xclip` owner, **105ms**. On a real desktop the blocked requester is mutter — on its single compositor thread — so the ENTIRE session freezes (observed 15–20s). All writes go through a detached `xclip -i` owner. |
| **Clipboard reads** | Must be off the UI thread. Electron's `clipboard.*` are synchronous X selection transfers; measured 107ms for plain text through mutter's bridge, and mutter#1065 documents hangs. All Linux reads are `xclip` child processes with a 1.5s timeout. |
| GPU compositing | **Fine.** Reports `enabled` once a window exists — an earlier "GPU is disabled" reading was an artifact of probing before any window was created (Chromium starts the GPU process lazily). |
| macOS `globalShortcut` | **YES — verified** on macOS 26.5.2. All five register; `register()` returns false on a conflict, so the return value is checked and reported. |
| macOS CGEvent ⌘V paste | **YES — verified** (5/5 into a real NSTextView) *provided the posting process does not exit immediately*. See rule 6. |
| macOS AX selected text | **Partly.** `kAXSelectedText` on the **per-application** element works; on the **system-wide** element it returns nothing to a background CLI caller. Chain is AX → menu-bar Copy (found by ⌘C command-char, not the title) → synthetic ⌘C with full pasteboard backup/restore. |
| macOS NSPasteboard polling | **Do not poll from the main process.** Reading the pasteboard to detect change costs 55.7ms per poll with a screenshot on it (measured, 3024x1964) — a PNG re-encode of something nobody touched. `changeCount` is polled by the helper in its own process (0.0% CPU, 1.6MB RSS) and pushes a line on real changes only. |
| macOS audio decode | AVFoundation reads m4a/AAC, mp3, wav, aiff, caf. It **cannot** read WebM or Opus ("no audio track" — verified), so the renderer records `audio/mp4;codecs=mp4a.40.2` on darwin. macOS ships no ffmpeg. |
| macOS interactive screenshot | `screencapture -i <file>` (to a file, not `-c`, so it doesn't bounce through the pasteboard where our own capture would re-ingest it). Cancelling exits 0 having written nothing — test for the file, not the exit code. |
| Available AI auth | `OPENAI_API_KEY`, `GEMINI_API_KEY` in env (Groq deliberately unused); `claude` + `codex` CLIs subscription-authed, consumed via their SDKs. |

### Operational invariants (added after the mature-Electron-app review)
- **Electron is pinned exactly** (43.2.0, no caret). 43.3.0 broke the AppIndicator
  tray on GNOME 50 Wayland (electron#52674). Re-test tray + globalShortcut on every bump.
- **Native modules must be verified in a PACKAGED build**, not just `pnpm dev`:
  sqlite-vec silently failed to load from inside app.asar, disabling semantic search
  in the installed app only.
- **The UI process never owns the X clipboard and never reads it synchronously**
  (see the freeze story below).
- **Nothing heavy runs on the main thread**: SQL is synchronous but cheap; embeddings
  and ASR live in utilityProcesses that unload when idle.
- **Logs are redacted at the transport**, never by caller discipline, and clipboard
  events log metadata only — never content.
- **Fail closed**: an uncaught exception in main closes the DB and exits rather than
  limping on with an open write handle.
- **The package manager is pinned** (`packageManager: pnpm@10.18.0`). `pnpm-workspace.yaml`
  uses pnpm 10 syntax; under pnpm 9 both `overrides` and the build allowlist are silently
  ignored, and `pnpm install` fails outright on Node 22 (pnpm 9 injects node-gyp 7, which
  writes to a frozen `process.config`). Config that is silently ignored is worse than
  config that errors.

### Hard-won rules (do not regress these)
1. **Never own the X clipboard from the UI process.** It can freeze the user's whole desktop.
2. **Never read the clipboard synchronously on the UI thread.** Same blast radius, smaller fuse.
3. **Never fight the Wayland compositor over window geometry.** No positioning, no saved bounds, no "recenter" logic on Wayland.
4. **Never gate showing a window on `ready-to-show`** — a hidden window has no Wayland surface, so it may never paint and the event may never fire. Use `did-finish-load` + a timer backstop.
5. **Measure before theorising.** Three wrong root causes were asserted here (sync settings writes, GPU, WM sync protocol) before an isolated Xvfb reproduction found the real one. `Xvfb :99` is the right tool; never experiment on the user's live session. On macOS the equivalent is `src/native/mac/axprobe.swift` — a disposable AppKit target the helper can be exercised against, because driving a real app needs Automation TCC permission whose prompt cannot be answered headlessly.
6. **Never post a CGEvent and exit.** The window server delivers asynchronously; a short-lived process dies before the keystroke lands. Measured: 0ms drain → 0/3 pastes arrived, 5ms → 3/3. The helper sleeps 30ms after posting. This fails *intermittently*, which is the worst way for it to fail.
7. **Never detect clipboard change by reading the clipboard.** On both platforms the read is the expensive part (Linux: a blocking X selection transfer; macOS: a full PNG re-encode, 55.7ms measured). Detect with a cheap change signal in another process — XFixes on Linux, `changeCount` in the helper on macOS — and read only when it fires.
8. **Verify native modules and spawned binaries in a PACKAGED build.** Three separate bugs shipped invisibly in dev: sqlite-vec (historic), the onnxruntime binding pruned out of the macOS build by a shared `files` exclusion, and both AI SDKs spawning a CLI path inside `app.asar` — which is a *file*, so `spawn` fails with ENOTDIR even though `require` and `fs` work fine on it.

## 3. Architecture

Electron app running **native Wayland** on Linux (`ozone-platform-hint=auto`) — like every
other well-behaved Electron app on Ubuntu. Clipboard access does not depend on Electron's
backend at all: an independent X connection (Xwayland) watches for changes and helper
processes do every read and write. See §2 for why each of those choices is load-bearing.

```
┌────────────────────────── Electron main ──────────────────────────┐
│  CaptureService (per-platform adapter)                            │
│    linux: XFixes event watcher (no polling) + xclip read helpers  │
│    darwin: changeCount poller (NSPasteboard has no push API)      │
│  → filter chain: ignore-list, ConcealedType/x-kde-hint,           │
│    secret heuristics (AWS keys, JWTs, private keys), dedupe       │
│  → Store: better-sqlite3 (one file: items + FTS5 + sqlite-vec)    │
│  → EnrichmentQueue (utilityProcess, async, opt-in):               │
│      images → OCR/describe/tags  (subscription or API lane)       │
│      text   → classify/tags, local embeddings (EmbeddingGemma)    │
│  ProviderRouter                                                   │
│    subscription lane: `claude -p --output-format json`,           │
│                       `codex exec` (child processes, $0 marginal) │
│    api lane: GPT-5.6 Luna / Groq / Gemini (fast, interactive)     │
│  HotkeyService: gnome-keybinding→second-instance | globalShortcut │
│  PasteService: darwin CGEvent helper | linux tier0 toast /        │
│                tier1 RemoteDesktop portal / tier2 ydotool         │
│  SelectionService (rewrite feature):                              │
│    linux: PRIMARY via bridge on hotkey                            │
│    darwin: AX kAXSelectedText → Cmd+C fallback (Swift helper)     │
│  McpServer (later): expose search/history to agents               │
└──────────────┬────────────────────────────────────────────────────┘
               │ IPC
   Popup window (frameless, keyboard-first, list + preview pane)
   Settings window · Tray (optional; appindicator flaky on 26.04)
```

### Storage
- One SQLite file: `items` (content, html/rtf, type, source_app, ts, pinned, tags JSON,
  ocr_text, description) + `items_fts` (FTS5 over content+ocr+notes+tags) + `items_vec`
  (sqlite-vec, 256-d Matryoshka-truncated EmbeddingGemma vectors).
- Hybrid search: FTS5 BM25 top-50 ∪ vec KNN top-50 → Reciprocal Rank Fusion.
- Images: thumbnails in DB, originals on disk (content-addressed), lazy-loaded.
- Retention: user-configurable, default generous; VACUUM scheduling; full export/import.

### AI stack (from pricing/quality research, Aug 2026)
- **Vision (OCR+describe+tag)**: GPT-5.6 Luna, strict JSON schema — ~$0.17/mo @ 200 images.
  Subscription-lane alternative: `claude -p` with image path. Fallback: Gemini 2.5
  Flash-Lite (cheapest, needs zod+retry wrapper), tesseract.js offline, Apple Vision
  helper on macOS (`@cherrystudio/mac-system-ocr`, run in child process).
- **Rewrite**: interactive → Luna or Groq Llama 4 (sub-second); "in your voice" via
  user-editable prompt profiles + few-shot samples of user's writing.
- **Embeddings**: local EmbeddingGemma-300M @256d via transformers.js/onnxruntime in a
  `utilityProcess` — clipboard text never leaves the machine for indexing. (API
  embeddings only as opt-in.)
- **Transcription (later)**: sherpa-onnx + NVIDIA Parakeet TDT 0.6B v3 — SOTA local
  realtime STT (6.32% WER, streaming-native, Node addon, CUDA on Linux / CoreML on
  Apple Silicon). Cloud fallback Groq whisper-large-v3-turbo @ $0.04/hr.
- **Never** scrape Claude/Codex OAuth tokens for raw API calls (ToS-fragile). The
  sanctioned subscription surface is the official SDKs: **Claude Agent SDK**
  (`@anthropic-ai/claude-agent-sdk`, typed, rides Claude Code's subscription auth) and
  **Codex SDK** (`@openai/codex-sdk`). API lane: one OpenAI-compatible client covers
  OpenAI + Groq + Gemini (same wire format, three configs).
- **ModelPort adapter (decided 2026-08-06)**: every AI feature calls one interface
  (`complete`, `completeJson<S>(schema)`, `vision`, capabilities descriptor). Backends:
  claude-agent-sdk | codex-sdk | openai-compat. Routing per feature in settings — the
  app core is agnostic to subscription vs API vs specific model.

## 4. UX — the core of the product

Design principle: **the popup is a command surface, not a list.** Every clip is one
keystroke away from being transformed by AI before it lands in the target app. The goal
is to supercharge interactions with every other application, not to be a history viewer.

### The palette (global hotkey)
- Search field auto-focused; typing filters instantly (FTS + fuzzy; later semantic).
- **Prompt-first (2026-08-08, John's call):** selection opens on an "ask assistant" row
  above the history; `Enter` on typed text asks the personal-assistant agent session
  (reply lands in the inbox). `↓` moves into history, where everything behaves exactly
  as before. This inverts Raycast's Tab-to-AI: ask is the default, search-paste is one
  arrow away (`⌘1..9` still quick-pastes directly).
- `↑↓` navigate · `Enter` paste · `Shift+Enter` paste as plain text · `Ctrl+Enter` copy
  only · `Ctrl+1..9` paste nth item · `Esc` dismiss.
- `⌘J` (or the `Send to agent…` action row) sends the selected clip into an existing
  or new agent session · `⌘N` makes a note from the clip · `Tab`/`⌘K` action panel ·
  `⌘/` shortcut overlay.
- List + rich preview pane (selectable text, enrichment shown: auto-title, tags, OCR
  text, source app icon).
- Type/collection filters one keystroke away (`Ctrl+F` cycle or click chips):
  Text / Images / Links / Code / Files + smart collections.

### Transform-before-paste (the differentiator)
- **`Tab` on any item → Action Mode**: an inline bar where you either
  1. type a **free-text AI prompt** — "as CSV", "translate to German", "make it
     polite", "extract the URLs" — `Enter` shows the transformed preview, `Enter`
     again pastes it; or
  2. fuzzy-pick a **saved action** (Fix typos, Plain text, My voice, Summarize,
     JSON→pretty, …).
- **Single-key saved transforms** inside Action Mode (Pastebot's paste-filters idea,
  but AI-powered): any prompt can be saved as a named action with a one-letter
  binding. Deterministic transforms (trim, case, plain-text) run instantly offline;
  AI ones hit the fast lane (Groq/Luna, sub-second).
- Transformed results are themselves saved to history (marked as derived), so nothing
  is ever lost.
- **Images get Action Mode too**: `Tab` on a screenshot →
  1. instant local ops — crop, annotate (arrows/boxes/text), **auto-redact** (OCR
     bounding boxes → blur emails/keys/names before sharing), format convert, compress;
  2. free-prompt AI edits — "remove the background", "blur the faces", "crop to just
     the dialog" — via cheap image-edit models (gpt-image mini / Gemini image);
  3. a lightweight built-in annotator window for hand markup (M4).
  Edited images are derived clips; original always retained.

### Auto-organization (zero manual filing)
- Every captured clip is enriched in the background (subscription lane, opt-in):
  **auto-title** (list shows "PG connection string for staging", not a wall of text),
  **auto-tags**, **content class** (code+language / link / error / address / meeting /
  prose / screenshot-of-X…).
- **Smart collections** are saved searches over those facets — Code, Errors,
  Screenshots, Links, Contact info — they populate themselves. Users can define their
  own ("anything that looks like a SQL query") as natural-language rules evaluated at
  classification time.
- Dedupe on re-copy; derived/transformed clips grouped under their source.

### Link enrichment & Sessions
- **Copied URLs get fetched** (opt-in, background): title + readable-text extraction
  (local fetch + Readability first; Firecrawl-style API as optional upgrade for
  JS-heavy pages) → summary + tags indexed into search. Searching "that pricing
  comparison" finds the link you copied, not just its URL string.
- **Sessions**: clips cluster automatically by time proximity + content affinity into
  named sessions ("Tue 14:00 — debugging stripe webhooks", auto-titled by AI from the
  clips). Browsable as collections; a whole session can be exported as one markdown doc.

### Selection rewrite (separate hotkey, no popup needed)
- Capture current selection (PRIMARY on Linux, AX/Cmd+C chain on macOS) → mini action
  palette at screen center → same saved-actions + free-prompt model → result replaces
  the selection where injection is available, else clipboard + "press Ctrl+V" toast.
- Prompt profiles: "my voice" built from few-shot samples the user pastes in settings.

### Onboarding
- Linux: writes the GNOME custom keybinding automatically (gsettings), explains the
  paste-back tiers honestly, offers the portal upgrade.
- macOS: one-time Accessibility request with a clear explainer (the Maccy pattern).
- Popup centered on Linux (Wayland cursor coords unreliable), at cursor on macOS.

## 4.5 Decisions (2026-08-06, with John)

1. **Commercial-grade from the start**: personal tool first, but built to be commercially
   viable — open-sourcing or selling stays open. Private repo, no OSS license yet, BYOK,
   zero telemetry, real packaging quality.
2. **Local-first now, sync-ready schema**: cross-machine sharing is a likely future —
   content hashes already exist per item; keep export/import lossless; E2EE sync is a
   post-M4 track, never half-shipped.
3. **Providers via SDKs, not CLI subprocesses** (see ModelPort above).
4. **All AI defaults are settings**, shipped with sensible values (enrichment→API lane,
   sessions/link-fetch off until enabled), trivially tweakable later.

## 5. Milestones

- **M1 — Rock-solid clipboard manager (MVP)**: capture text+images (verified paths),
  SQLite store, popup UI, FTS5 search, pin, dedupe, ignore rules + secret detection,
  paste (macOS inject / GNOME tier-0), GNOME keybinding onboarding, tray, export.
- **M2 — Intelligence**: enrichment queue, provider router (subscription + API lanes),
  image OCR/describe/tag, auto-classification, local embeddings, hybrid semantic search.
- **M3 — Selection AI**: rewrite-selection flow both platforms, prompt profiles
  ("my voice" few-shot), clip transforms / paste-as-prompt-templates.
- **M4 — Power features**: paste stack, MCP server, RemoteDesktop-portal paste-back
  (tier 1), snippets/collections, optional Parakeet transcription sidebar.

## 6. Open items to verify in code
1. XFixes selection events fire under the bridge for native-Wayland-app copies.
2. RemoteDesktop portal `restore_token` persistence on GNOME 50 (one dialog, not per-boot).
3. appindicator tray icon on Ubuntu 26.04 (issue #628).
4. `claude -p` / `codex exec` image-input latency + rate-limit behavior for the enrichment queue.
5. macOS: verify AX grant attaches to app bundle (not helper) in signed build.
