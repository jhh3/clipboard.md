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

## Development

```bash
pnpm install
pnpm dev          # run with HMR
pnpm test         # store-layer tests
pnpm typecheck
pnpm build:linux  # AppImage + deb
pnpm build:mac    # dmg (run on macOS; see MACOS-VALIDATION.md)
```

## Platform notes (honest edition)

- **Linux/GNOME Wayland**: capture works through mutter's Xwayland clipboard bridge
  (verified — GNOME does not expose data-control to normal clients as of 50.1).
  Global hotkeys are GNOME custom keybindings (written automatically on first run).
  Auto-paste uses the XDG RemoteDesktop portal — one permission dialog, once.
  Screen capture uses the Screenshot portal.
- **macOS**: pasteboard polling + CGEvent paste via a small Swift helper (one-time
  Accessibility grant). See `MACOS-VALIDATION.md` for the build-out checklist.
- Architecture ground truth and decision history: `DESIGN.md`.
