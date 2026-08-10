# clipboard.md

**A keyboard-first clipboard manager with an AI assistant built in.** Everything you
copy is captured, searchable, and one hotkey away from being pasted, rewritten by AI,
or handed to an agent — all on your own machine, on your existing Claude subscription.

- 🔍 **Search everything you've copied** — by words or by meaning ("that error from Tuesday")
- 🤖 **Ask an agent right from the launcher** — type a question, get an answer, paste it
- ✨ **Transform before pasting** — "as a table", "make it polite", fix typos
- 🎙️ **Dictate** — hold a key, talk, and it types (or asks your agent)
- 🔒 **Private by default** — nothing leaves your machine except the AI calls you choose; passwords and secrets are never captured

---

## Install (macOS)

**Option A — download it.** Grab `clipboard.md-*.dmg` from the
[**latest release**](../../releases/latest), open it, and drag the app to Applications.

> The first launch shows *"clipboard.md is damaged and can't be opened."* It's **not**
> damaged — the build just isn't notarized yet. **Right-click the app → Open → Open**,
> once, and it's fine forever after.

**Option B — build it (no warning at all).** A locally-built app skips the whole
Gatekeeper dance:

```bash
corepack enable && xcode-select --install      # one-time setup
git clone https://github.com/jhh3/clipboard.md && cd clipboard.md
pnpm install && make mac-install
```

Either way: it starts at login, adds a menu-bar icon, and asks for **Accessibility** the
first time (that's what lets it paste — grant it). Then press **`⌘⇧V`** and start typing.

**Turning on the AI (10 seconds).** It uses whatever you already have, in this order:

1. **A `claude` or `codex` login** — if you've run either in a terminal and signed in, you're
   done; it's picked up automatically and costs nothing beyond your plan.
2. **A standard API key in your environment** — `OPENAI_API_KEY`, `GEMINI_API_KEY`, or
   `ANTHROPIC_API_KEY` exported in your shell rc is imported automatically at launch (even
   when the app is opened from Finder, which normally can't see your shell's `export`s).
3. **A key you paste into Settings → AI Providers** — the reliable manual option, and it
   always wins over the environment.

So for most people: *nothing to configure.* If none of the above is set, open Settings →
AI Providers and paste one key.

> **Using Wispr Flow (or another dictation app)?** Quit it, or change its hotkey — its
> hold-to-talk key collides with clipboard.md's (`🌐`/Fn), and both will fire at once.

*(Linux install is [further down](#linux).)*

---

## The shortcuts worth knowing

Global (from anywhere):

| Key | Does |
|---|---|
| **`⌘⇧V`** | Open the clipboard palette |
| **hold `🌐` (Fn)** | Dictate — hold, talk, release |
| **`⌘⇧R`** | Rewrite selected text (fix typos / your voice / any prompt) |
| **`⌘⇧S`** | Screenshot into history |
| **`⌘⇧N`** · **`⌘⇧A`** | Notes · Agent inbox |

Inside the palette:

| Key | Does |
|---|---|
| type, then **`↵`** | Ask your agent — the answer appears right there |
| **`↓`** then `↵` | Plain clipboard history — paste the highlighted clip |
| **`Tab`** | Actions on a clip (transform, **`a`** ask about it, **`e`** edit image) |
| **`⌘J`** · **`@name`** / **`⇧Tab`** | Send a clip to an agent · switch which agent you're asking |
| **`⌘/`** | Show every shortcut · **`Esc`** closes |

---

## How it works

The palette (`⌘⇧V`) is the whole app. It opens on an **ask row**: type a question and
hit Enter, and a persistent Claude session answers inline, rendered as markdown, ready
to paste. Press `↓` instead and it's a fast fuzzy search over everything you've ever
copied — full-text *and* semantic.

`Tab` on any clip opens its actions: an AI transform ("as CSV", "translate to German"),
**`a`** to ask an agent *about* that clip (a copied link brings its fetched page text
along; a screenshot brings its OCR), or **`e`** to edit an image ("circle the error in
red", back in ~3s).

Dictation is hold-to-talk on the `🌐` (Fn) key: hold, speak, release, and the transcript
lands in whatever app you're using — or in the palette's ask box if it's open. It runs
**on-device** by default; no audio leaves your machine.

Everything organizes itself — every clip gets an AI title, tags, and a type; links get
fetched and summarized; screenshots get OCR'd — so search finds things by what they
*were about*, not just their text.

### vs. Wispr Flow and friends

Same instant hold-to-talk feel, but it's a whole clipboard + agent surface rather than
just dictation, it's local-first, and it runs free on your existing Claude/Codex
subscription. It stays fast the boring way: an **event-driven** clipboard watcher (no
polling), a tiny Swift helper for native paste injection, **offline on-device** speech
recognition, fast-by-default models, and pre-warmed agent sessions so your first ask
isn't a cold start.

---

## Configuration (and the defaults)

Sensible out of the box — you only open Settings if you want to change something.

- **AI provider** — auto-configured from what you already have, in order: your
  **`claude`/`codex` login** (read from disk, works however the app starts), then a
  standard **`OPENAI_API_KEY` / `GEMINI_API_KEY` / `ANTHROPIC_API_KEY`** from your shell
  (imported at launch, so a Finder-opened app sees it too), then a key you paste in
  **Settings → AI Providers** (which always wins). Existing values are never overwritten.
  Two lanes, per feature: *subscription* (free at the margin, default for background work)
  and *API* (faster, default for interactive transforms — ~$0.20/month at normal use).
  If you've no API key, transforms fall back to your subscription rather than failing.
  Default models are the fast, cheap ones: **Haiku · GPT-5.6 Luna · Gemini Flash-Lite**.
- **Dictation** — transcription is **OpenAI by default**, or switch to fully-offline
  **local Parakeet** (a ~490MB one-time download, then no audio ever leaves the machine).
  The hold-to-talk key is rebindable in Settings → General.
- **Image editing** — **Nano Banana 2 Lite** by default (fast, cheap); GPT Image 2 and
  the bigger Nano Banana models are selectable.
- **Agents** — define as many as you like in Settings → Agents (each with its own
  identity, working directory, and long-term memory); the first is your primary
  assistant. Agents can also run in a cloud sandbox instead of locally (opt-in).
- **Privacy** — password-manager copies are ignored; keys, tokens and other secrets are
  detected as they're copied, masked, and never indexed, embedded, or sent to any AI.
  Semantic search embeddings are computed locally.

**Feedback is very welcome** — open an issue or just tell me what felt off.

<details>
<summary><b>Everything it can do (the full list)</b></summary>

- **History palette** (`⌘⇧V`) — search by words or meaning; Enter pastes into the app you came from.
- **Ask your agents** — the ask row answers inline; define multiple agents; `⇧Tab` cycles them, `@name` autocompletes one, `↑` reopens the last conversation. `Tab a` on any clip asks *about* it.
- **Edit images with AI** — `Tab e`: "remove the background", "circle the error in red" — edited image back in ~3s, previewed and pasteable.
- **Transform before pasting** — `Tab`: a free-form instruction or a saved one-key action. Preview, then paste.
- **Rewrite what's on screen** (`⌘⇧R`) — highlight text anywhere, pick fix-typos / your-voice / a prompt; the selection is replaced.
- **Dictate** (hold `🌐`) — types into whatever you're using, or asks the agent when the palette is open. Local, no audio leaves the machine.
- **Screenshots & images are searchable** — captured images are OCR'd and described; convert, compress, or **auto-redact** sensitive text.
- **Organizes itself** — titles, tags, types; related clips group into sessions; smart collections fill themselves.
- **Notes** (`⌘⇧N`) — a real editor with `[[wikilinks]]`, sharing the same search.
- **Links get read for you** — copy a URL and the page is fetched and summarized.

</details>

<details>
<summary><b>Agents & the MCP server</b></summary>

Installing the app registers a clipboard MCP server with Claude Code on first run, so
*any* of your local agents can search your clipboard — nothing extra to install.

Tools: `clipboard_search`, `clipboard_recent`, `clipboard_get`, `clipboard_sessions`,
`clipboard_copy`. Secret-flagged clips are refused at the tool layer. Works whether or
not the app is running.

Register it by hand elsewhere:

```bash
claude mcp add --scope user clipboard -- /path/to/clipboard.md --mcp
```

The app is also a two-way console: `⌘J` sends a clip into a running Claude Code session
(or starts one). Agents report progress, ask questions, and save notes back into the
inbox (`⌘⇧A`).

</details>

<details>
<summary><b>Linux</b></summary>

### Install

| Download | How |
|---|---|
| `clipboard-md_*_amd64.deb` | Double-click → **Install**. Recommended for Ubuntu/Debian/Pop!_OS. |
| `clipboard.md-*.AppImage` | Right-click → Properties → **Allow executing**, then double-click. |

First paste pops a *"Allow remote control?"* dialog — say yes, or text is copied but not
typed into the target app. Needs `xclip` (and `ffmpeg` for local dictation).

### Shortcuts

`Ctrl+Alt+V` palette · `Ctrl+Alt+Space` dictate · `Ctrl+Alt+R` rewrite ·
`Ctrl+Alt+S` screenshot · `Ctrl+Alt+E` scratchpad · `Ctrl+Alt+N` notes ·
`Ctrl+Alt+A` inbox. They're GNOME custom keybindings, editable in system Settings →
Keyboard → Custom Shortcuts.

### If something isn't working

```bash
make doctor      # checks what commonly breaks, and says what's wrong
make logs        # follow today's log
```

- **A shortcut does nothing** — another app owns it (check Settings → Keyboard).
- **Dictation won't stop on release** — key repeat must be ON in Settings → Keyboard.
- **Copied but not pasted** — the remote-control permission was declined; dictate once more and accept it.
- **Nothing captured** — only one instance may run (`make doctor` counts them), and `xclip` must be installed.

</details>

<details>
<summary><b>Development & architecture</b></summary>

```bash
pnpm install
pnpm dev            # hot reload
pnpm test           # unit tests
pnpm typecheck
make mac-install    # macOS: build + install to /Applications
make appimage       # Linux: build the downloadable artifacts
```

Don't start the binary by hand — the app depends on session state that's easy to get
wrong, and each variation fails in a way that looks like a different bug.

**Requirements:** Node 22+, pnpm. Linux also needs `xclip` (+ `ffmpeg` for local
dictation), GNOME 48+ recommended.

**Platform notes**
- **macOS** — a small Swift side-car handles paste injection, reading selected text, the frontmost app, and audio decoding. Releases are development-signed (see the install note); a notarized build needs an Apple Developer ID cert.
- **Linux/GNOME** — clipboard I/O is X11 (`xclip`, XFixes) out-of-process, so the app never owns the X clipboard (owning it can freeze the GNOME session). Hotkeys are GNOME keybindings; paste uses the RemoteDesktop portal; capture uses the Screenshot portal.
- `docs/DESIGN.md` — architecture, measured platform ground truth, and the decision history. `docs/MACOS-VALIDATION.md` — what's verified on hardware. `docs/SYNC-DESIGN.md`, `docs/REMOTE-AGENTS.md` — cross-machine sync and remote-execution designs.

</details>
