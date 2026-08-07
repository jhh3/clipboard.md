# clipboard.md

A local-first, keyboard-first, AI-supercharged clipboard manager for Linux and macOS.

Everything you copy is captured, classified, and indexed — then one hotkey away from
being searched, transformed by AI, or pasted anywhere. Powered by **your existing
Claude / Codex subscriptions** or API keys (BYOK). No accounts, no telemetry, no
subscription of its own, nothing leaves your machine except the AI calls you configure.

## What it does

- **History palette** (`Ctrl+Alt+V` / `⌘⇧V`) — instant keyboard-first search over
  everything you've copied: full-text + semantic ("that error from Tuesday"). Enter
  pastes straight into the app you came from.
- **Transform before paste** — `Tab` on any item opens Action Mode: type a free-form AI
  prompt ("as CSV", "translate to German", "make it polite") or hit a single-key saved
  action (fix typos, plain text, JSON pretty…). Preview, then paste the result.
- **Auto-organization** — background AI gives every clip a title, tags, and class
  (code / link / error / address / screenshot…); smart collections fill themselves;
  clips cluster into named work **sessions**.
- **Images are first-class** — screenshots get OCR'd and described so search finds
  them; Action Mode on an image: convert, compress, **auto-redact sensitive text**
  (emails, keys, long numbers — OCR-guided, fully local).
- **Selection rewrite** (`Ctrl+Alt+R`) — highlight text in any app, hit the hotkey,
  pick "fix typos" / "my voice" / free prompt, and the rewrite replaces the selection.
- **Scratchpad** (`Ctrl+Alt+E`) — a quiet editor over your clipboard: dictate into it
  (speech-to-text), edit, then save/copy/paste.
- **Built-in screen capture** (`Ctrl+Alt+S`) — GNOME's own area/window/screen picker,
  straight into history.
- **Link intelligence** — copy a URL and the page gets fetched, summarized, and
  indexed, so search finds *what the page was about*.
- **Privacy posture** — password-manager copies are honored (`ConcealedType`,
  KDE hints); secrets (keys, JWTs, high-entropy tokens) are detected at capture,
  masked in the UI, and **never** indexed, enriched, or embedded. Semantic search
  embeddings are computed locally (bge-small via ONNX) — clipboard text never leaves
  the machine for indexing.

## AI: two lanes, one adapter

Every AI feature goes through a single ModelPort interface, routed per-feature in
Settings:

- **Subscription lane** — Claude Agent SDK (rides your `claude` login) and Codex SDK
  (rides your `codex` login). Zero marginal cost; used for background enrichment by
  default. Both also accept `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`.
- **API lane** — one OpenAI-compatible client covering OpenAI (GPT-5.6 Luna) and
  Gemini. Sub-second; used for interactive transforms by default (~$0.20/month at
  normal usage).

## MCP server (agents ⇄ your clipboard)

A built-in stdio MCP server lets local agent sessions search and use your clipboard:

```bash
claude mcp add clipboard -- node /path/to/clipboard.md/out/main/mcp.mjs
```

Tools: `clipboard_search`, `clipboard_recent`, `clipboard_get`, `clipboard_sessions`,
`clipboard_copy`. Secret-flagged clips are refused at the tool layer. Works even when
the app isn't running (reads the same SQLite file; WAL keeps concurrent readers safe).

## Development

```bash
pnpm install
pnpm dev          # run with HMR
pnpm test         # store-layer tests
pnpm typecheck
pnpm build:linux  # AppImage + deb
pnpm build:mac    # dmg (run on macOS; see MACOS-VALIDATION.md)
```

## Keyboard shortcuts (Linux defaults)

| Shortcut | Action |
|---|---|
| `Ctrl+Alt+V` | Clipboard palette |
| `Ctrl+Alt+R` | Rewrite the current selection |
| `Ctrl+Alt+S` | Screenshot into history |
| `Ctrl+Alt+E` | Scratchpad |
| `Ctrl+Alt+D` | Dictate (press again to stop) |

On macOS these are `⌘⇧V / R / S / E / D`. Linux shortcuts are registered as GNOME
custom keybindings on first run (Electron's own global shortcuts don't work on GNOME
Wayland), so they're editable in Settings → Keyboard. The app installs a login
autostart entry so the shortcuts talk to an already-running instance.

In the palette: `↵` paste · `⇧↵` paste as plain text · `⌃↵` copy · `⌃1–9` quick-paste ·
`Tab` Action Mode · `⌃E` scratchpad · `⌃⇧S` screenshot · `Esc` dismiss.

## Platform notes (honest edition)

- **Linux/GNOME Wayland**: runs as a native Wayland app. Clipboard capture is
  event-driven via XFixes on an independent X connection, and every read/write happens
  in a helper process — the app never owns the X clipboard itself, because doing so can
  freeze the whole GNOME session when the compositor blocks waiting on it. Global
  hotkeys are GNOME custom keybindings. Auto-paste uses the XDG RemoteDesktop portal
  (one permission dialog, once); screen capture uses the Screenshot portal.
  Requires `xclip` (and `ffmpeg` for local dictation).
- **macOS**: written but **not yet validated on hardware** — pasteboard polling plus a
  small Swift helper (CGEvent paste, AX selected-text) that still needs building. See
  `MACOS-VALIDATION.md`.
- Architecture, measured platform ground truth, and the decision history (including the
  wrong turns and why they were wrong): `DESIGN.md`.

## Requirements

- Node 22+, pnpm
- Linux: `xclip`; `ffmpeg` for local transcription; GNOME 48+ recommended
- AI: any of a Claude subscription (`claude` login), Codex subscription (`codex` login),
  `OPENAI_API_KEY`, or `GEMINI_API_KEY`. Fast models are the default
  (Haiku / GPT-5.6 Luna / Gemini Flash-Lite) and are configurable per feature.
