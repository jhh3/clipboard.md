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
| Xwayland clipboard bridge (background X client read/write, no focus) | **YES — verified** (xclip round-trip on `DISPLAY=:0` with mutter's Xwayland auth). Mutter syncs CLIPBOARD + PRIMARY to Xwayland regardless of focus. |
| X11 XFixes selection-change events under the bridge | Mechanically implied (bridge takes X selection ownership on each change → `XFixesSetSelectionOwnerNotify` fires). **Verify in app skeleton first.** |
| Electron `globalShortcut` on GNOME 50 | Dead in both ozone modes (mutter ≥49 killed Xwayland grabs; portal path blocked by electron#51875). Use GNOME custom keybinding → CLI trigger → `second-instance`. |
| Keystroke injection (paste-back) on GNOME Wayland | No clean default. `wtype`/virtual-keyboard: unimplemented in mutter. `ydotool`: needs uinput setup (opt-in tier 2). **XDG RemoteDesktop portal** via D-Bus (`NotifyKeyboardKeycode`, `persist_mode=2`): sanctioned, one permission dialog (opt-in tier 1). Default: copy + "press Ctrl+V" toast — the industry norm on GNOME. |
| macOS (all of the above) | Solved territory: NSPasteboard `changeCount` poll @500ms, `globalShortcut` works, CGEvent Cmd+V via small Swift helper + one-time Accessibility permission (the Maccy pattern). |
| Available AI auth | `OPENAI_API_KEY`, `GROQ_API_KEY`, `GEMINI_API_KEY` in env; `claude` CLI 2.1.223 subscription-authed; `codex` CLI 0.146.0 subscription-authed. |

## 3. Architecture

Electron app. On Linux, **force Xwayland** (`app.commandLine.appendSwitch('ozone-platform', 'x11')`):
it restores window positioning, focusless clipboard/PRIMARY access via the bridge, at the
cost of fractional-scaling crispness. Revisit if/when GNOME exposes data-control publicly.

```
┌────────────────────────── Electron main ──────────────────────────┐
│  CaptureService (per-platform adapter)                            │
│    linux-x11bridge: XFixes event watcher (fallback: 500ms poll)   │
│    darwin: changeCount poller (native addon or objc bridge)       │
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
- `↑↓` navigate · `Enter` paste · `Shift+Enter` paste as plain text · `Ctrl+Enter` copy
  only · `Ctrl+1..9` paste nth item · `Esc` dismiss.
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
