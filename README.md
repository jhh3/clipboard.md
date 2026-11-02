# clipboard.md

**A fast, keyboard-first clipboard manager with dictation built in.** Everything you
copy is captured, searchable, and one hotkey away from being pasted — on your own
machine.

- 🔍 **Search everything you've copied** — by words or by meaning ("that error from Tuesday")
- 🎙️ **Dictate** — hold a key, talk, release, and it types. Speech recognition runs on-device
- ✨ **Rewrite selected text** — highlight, `⌘⇧R`, type how to change it (or just Enter to fix typos)
- 💬 **Ask a quick question** — type it in the palette, get a streamed answer, paste it
- 🔒 **Private by default** — audio and embeddings stay local; passwords and secrets are never captured

Linux (GNOME) and macOS.

---

## Install (macOS)

**Option A — build it (recommended, no warnings).** A locally-built app is trusted by
macOS, so it skips the Gatekeeper "damaged" dance:

```bash
git clone https://github.com/jhh3/clipboard.md && cd clipboard.md
make mac-install
```

You need [Node 22+](https://nodejs.org) first (it'll prompt you to approve Xcode's
command-line tools if they're missing).

**Option B — download it.** Grab `clipboard.md-*.dmg` from the
[**latest release**](../../releases/latest), open it, and drag the app to Applications.

> Because the download isn't notarized yet, the first launch shows *"clipboard.md is
> damaged and can't be opened."* It's **not** damaged — **right-click the app → Open →
> Open**, once, and it's fine forever after.

Either way: it starts at login, adds a menu-bar icon, and asks for **Accessibility** the
first time (that's what lets it paste — grant it). Then press **`⌘⇧V`** and start typing.

**AI features** (tagging, rewrite, ask, dictation cleanup) call OpenAI or Fireworks
directly with your own key. `OPENAI_API_KEY` / `FIREWORKS_API_KEY` exported in your shell
rc are imported automatically at launch, or paste a key in **Settings → AI**. Fireworks
is used first when its key is set (cheapest and fastest for short text).

> **Using Wispr Flow (or another dictation app)?** Quit it, or change its hotkey — its
> hold-to-talk key collides with clipboard.md's (`🌐`/Fn).

*(Linux install is [further down](#linux).)*

---

## Shortcuts

Global (from anywhere):

| Key | Does |
|---|---|
| **`⌘⇧V`** | Open the clipboard palette |
| **hold `🌐` (Fn)** | Dictate — hold, talk, release |
| **`⌘⌥D`** | Dictate with an AI cleanup pass (toggle) |
| **`⌘⇧R`** | Rewrite selected text |
| **`⌘⇧S`** | Screenshot into history |

Inside the palette:

| Key | Does |
|---|---|
| type, then **`↵`** | Ask — the answer streams in place; `↵` again pastes it |
| **`↓`** then `↵` | Paste the highlighted clip (`⇧↵` plain, `⌘↵` copy) |
| **`Tab`** | Attach the highlighted clip to your next question |
| **`⌘1–9`** | Quick-paste |
| **`⌘D`** | Voice input into the ask box |
| **`⌘/`** | Show every shortcut · **`Esc`** closes |

---

## How it works

The palette (`⌘⇧V`) is the whole app: a fast search over everything you've ever copied,
full-text *and* semantic, with an ask row on top for one-off questions.

Dictation is hold-to-talk: hold, speak, release, and the transcript lands in whatever
app you're using — or in the palette's ask box if it's open. It runs **on-device**
(Parakeet) by default; no audio leaves your machine. A built-in tech vocabulary spells
proper nouns right — "open ai" → OpenAI, "get hub" → GitHub — and you can add your own
terms in Settings.

Clips organize themselves: each gets an AI title, tags and a type; links get fetched;
screenshots get their text read — so search finds things by what they were about.

It stays fast the boring way: an **event-driven** clipboard watcher (no polling), a
tiny Swift helper for native paste on macOS, offline speech recognition, and direct API
calls to small, fast models.

---

## Configuration (and the defaults)

- **AI** — OpenAI (`gpt-6-luna` by default, `gpt-5.4-nano` selectable) and Fireworks
  (DeepSeek V4.1 Flash). Keys come from your shell environment or Settings → AI
  (Settings always wins). AI tagging can be switched off in Settings.
- **Dictation** — fully-offline local Parakeet by default (a ~490MB model downloads on
  first use). Switch to OpenAI in Settings to skip the download. The hold-to-talk key and
  the optional AI-cleanup key are rebindable in Settings → General.
- **Privacy** — password-manager copies are ignored; keys, tokens and other secrets are
  detected as they're copied, masked, and never indexed, embedded, or sent to any AI.
  Semantic search embeddings are computed locally.

<details>
<summary><b>Linux</b></summary>

### Install

| Download | How |
|---|---|
| `clipboard-md_*_amd64.deb` | Double-click → **Install**. Recommended for Ubuntu/Debian/Pop!_OS. |
| `clipboard.md-*.AppImage` | Right-click → Properties → **Allow executing**, then double-click. |

First paste pops an *"Allow remote control?"* dialog — say yes, or text is copied but not
typed into the target app. Needs `xclip` (and `ffmpeg` for local dictation).

### Shortcuts

`Ctrl+Alt+V` palette · `Ctrl+Alt+Space` dictate (hold) · `Ctrl+Alt+R` rewrite ·
`Ctrl+Alt+S` screenshot. They're GNOME custom keybindings, editable in system Settings →
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
- **macOS** — a small Swift side-car handles paste injection, reading selected text, the frontmost app, and audio decoding.
- **Linux/GNOME** — clipboard I/O is X11 (`xclip`, XFixes) out-of-process, so the app never owns the X clipboard (owning it can freeze the GNOME session). Hotkeys are GNOME keybindings plus the GlobalShortcuts portal; paste uses the RemoteDesktop portal; capture uses the Screenshot portal.
- `docs/DESIGN.md` — architecture, measured platform ground truth, and the decision history. `docs/MACOS-VALIDATION.md` — what's verified on hardware.

</details>
