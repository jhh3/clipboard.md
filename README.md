# clipboard.md

A local-first, keyboard-first, AI-supercharged clipboard manager for Linux and macOS.

Everything you copy is captured, classified and indexed — then one hotkey away from
being searched, rewritten by AI, or pasted anywhere. It runs on **your existing Claude
or Codex subscription** (or an API key). No account, no telemetry, no subscription of
its own. Nothing leaves your machine except the AI calls you configure.

---

## Install

Download the file for your system from the [**Releases**](../../releases/latest) page.

| System | Download | How to install |
|---|---|---|
| **Ubuntu / Debian / Pop!_OS** | `clipboard-md_*_amd64.deb` | Double-click it, then **Install**. Recommended. |
| **Any other Linux** | `clipboard.md-*.AppImage` | Right-click → Properties → tick **Allow executing**, then double-click. |
| **macOS** | `clipboard.md-*.dmg` | Open it and drag the app to Applications. |

That's the whole install. On first launch it sets itself up:

- **Starts automatically** when you log in, and stays running in the background.
- **Registers its keyboard shortcuts** (`Ctrl+Alt+V` opens it).
- **Adds an icon** to your menu bar / top bar — click it if you forget the shortcuts.
- **Connects itself to Claude Code**, so your agents can search your clipboard
  (see [Agents](#agents-and-the-mcp-server) below). Nothing else to run or configure.

Then press **`Ctrl+Alt+V`** (macOS: **`⌘⇧V`**) and start typing.

### First-run permissions

You'll be asked for a couple of things once. Both are needed for pasting to work, and
both can be changed later in your system settings.

- **Linux** — a *"Allow remote control?"* dialog the first time it pastes for you. Say
  yes; without it the text is copied but not typed into the app you're in.
- **macOS** — **Accessibility** (paste, and rewriting selected text) and, if you use
  screenshots, **Screen Recording**. The app asks and links you straight to the right
  settings pane.

### Uninstall

The `.deb` uninstalls from your software manager. The AppImage is a single file —
delete it. To remove your history and settings too, delete
`~/.config/clipboard.md` (macOS: `~/Library/Application Support/clipboard.md`).

---

## What it does

- **History palette** (`Ctrl+Alt+V`) — search everything you've copied, by words or by
  meaning ("that error from Tuesday"). Enter pastes it straight back into the app you
  came from.
- **Ask an assistant** — the palette opens on an ask row. Type a question, hit Enter,
  and a persistent Claude session answers — it can read your clipboard and notes.
  Press `↓` for plain history instead.
- **Transform before pasting** — `Tab` on any item: type an instruction ("as CSV",
  "translate to German", "make it polite") or hit a saved one-key action. Preview, then
  paste the result.
- **Rewrite what's on screen** (`Ctrl+Alt+R`) — highlight text in any app, hit the
  hotkey, pick *fix typos* / *my voice* / your own prompt. The selection is replaced.
- **Dictate** (hold `Ctrl+Alt+Space`) — hold, talk, release. The transcript is typed
  into whatever you're using. Runs locally; no audio leaves the machine.
- **Screenshots and images are searchable** — captured images are read (OCR) and
  described, so search finds them. Convert, compress, or **auto-redact** sensitive text.
- **Organizes itself** — every clip gets a title, tags and a type; related clips group
  into named sessions; collections fill themselves.
- **Notes** (`Ctrl+Alt+N`) — a real editor with `[[wikilinks]]`, sharing the same search.
- **Links get read for you** — copy a URL and the page is fetched and summarized, so
  search finds what the page was *about*.
- **Private by default** — password-manager copies are ignored. Keys, tokens and other
  secrets are detected as they're copied, masked in the app, and never indexed, sent to
  AI, or embedded. Semantic search is computed locally.

---

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Alt+V` | Clipboard palette |
| `Ctrl+Alt+Space` | Dictate (hold to talk) |
| `Ctrl+Alt+R` | Rewrite the selected text |
| `Ctrl+Alt+S` | Screenshot into history |
| `Ctrl+Alt+E` | Scratchpad |
| `Ctrl+Alt+N` | Notes |
| `Ctrl+Alt+A` | Agent inbox |

Inside the palette: `↵` ask / paste · `⇧↵` paste as plain text · `⌃↵` copy ·
`⌃1–9` quick-paste · `Tab` transform · `⌃J` send to an agent · `⌃/` show all
shortcuts · `Esc` close.

**On macOS** these are `⌘⇧V / R / S / E / N / A`, and dictation is **hold 🌐 (Fn)**
(`⌘⇧D` toggles as a fallback). If 🌐 already does something else, set System Settings →
Keyboard → *"Press 🌐 key to"* → **Do Nothing**.

**Changing them:** the dictation chord is in Settings → General → *Hold-to-talk chord* —
click it and press the keys you want. On Linux the others are GNOME custom keybindings,
editable in your system Settings → Keyboard → Custom Shortcuts.

---

## Agents and the MCP server

Installing the app also gives your local agents access to your clipboard — it registers
itself with Claude Code on first run, so there's nothing to install separately.

Tools: `clipboard_search`, `clipboard_recent`, `clipboard_get`, `clipboard_sessions`,
`clipboard_copy`. Secret-flagged clips are refused at the tool layer. It works whether
or not the app is running.

To register it by hand (another agent, or a different machine):

```bash
claude mcp add --scope user clipboard -- /path/to/clipboard.md.AppImage --mcp
```

The app is also a two-way agent console: `⌃J` sends a clip into a running Claude Code
session, or starts a new one with the clip as its prompt. Agents report progress, ask
questions and save notes back into the app's inbox (`Ctrl+Alt+A`).

---

## AI setup

It works out of the box if you're already signed in to `claude` or `codex` — it rides
that subscription at no extra cost. Otherwise add an `OPENAI_API_KEY` or
`GEMINI_API_KEY` in Settings → AI Providers.

Two lanes, chosen per feature in Settings:

- **Subscription** — Claude Agent SDK / Codex SDK, using your existing login. Free at
  the margin, so it's the default for background work.
- **API** — one OpenAI-compatible client covering OpenAI and Gemini. Faster, so it's the
  default for interactive transforms (roughly $0.20/month at normal use).

Defaults are the fast, cheap models (Haiku · GPT-5.6 Luna · Gemini Flash-Lite).

---

## If something isn't working

```bash
make doctor      # checks everything that commonly breaks, and says what's wrong
make logs        # follow today's log
```

The most common causes:

- **A shortcut does nothing** — another app already owns it. Check your system
  Settings → Keyboard for a conflict.
- **Dictation records but won't stop on release** — key repeat must be ON in Settings →
  Keyboard. It's what tells the app you're still holding the keys.
- **Text is copied but not pasted** — the remote-control permission was declined. On
  Linux, dictate once more and accept the dialog; on macOS, enable Accessibility.
- **Nothing is being captured** — make sure only one copy is running (`make doctor`
  counts them), and that `xclip` is installed.

---

## Development

```bash
pnpm install
pnpm dev            # run with hot reload
pnpm test           # unit tests
pnpm typecheck

make run            # build and (re)start a single background instance
make status         # running? which display backend? capture/dictation state
make stop           # stop it, strays included
make appimage       # build the downloadable artifacts into dist/
```

Do not start the binary by hand. The app depends on session state that is easy to get
wrong, and each variation fails in a way that looks like a different bug — a missing
`DISPLAY` silently disables clipboard capture and paste, and a stray second instance
means two processes writing the same database.

**Requirements:** Node 22+, pnpm. Linux also needs `xclip`, plus `ffmpeg` for local
dictation. GNOME 48+ recommended.

### Platform notes

- **Linux/GNOME** — clipboard I/O is X11-based (`xclip`, XFixes) on an independent
  connection, and every read and write happens out of process: the app never owns the X
  clipboard itself, because doing so can freeze the whole GNOME session. Global hotkeys
  are GNOME custom keybindings, since Electron's own don't work on Wayland. Auto-paste
  uses the XDG RemoteDesktop portal; screen capture uses the Screenshot portal. The app
  runs under Xwayland when hardware acceleration is available (it can place its own
  windows there) and native Wayland when it isn't.
- **macOS** — a small Swift side-car handles paste, reading the selected text, the
  frontmost app, and audio decoding. See `MACOS-VALIDATION.md` for what has been
  verified on hardware.
- `DESIGN.md` has the architecture, the measured platform ground truth, and the
  decision history — including the wrong turns and why they were wrong.
