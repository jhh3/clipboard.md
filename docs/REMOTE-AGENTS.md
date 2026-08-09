# clipboard.md — Remote Agent Sessions Feasibility

*Drafted 2026-08-09 from four research streams (Cloudflare, E2B, Daytona, auth/ToS +
architecture audit), grounded against `src/main/agents.ts` and docs/SYNC-DESIGN.md as
of `2b94911`. Companion to docs/DESIGN.md; same rule applies: decisions come with
reasons.*

## 1. Goal & constraints

Run an agent session's `claude` process in a remote sandbox instead of a local tmux
session, so agents survive lid-close, don't compete with the laptop for RAM, and are
reachable from any machine once sync lands. The constraints, in order:

1. **Fast startup.** The local cold start is 10–30s of claude booting plus menu
   babysitting (`prewarmAgents()`, `waitForChatReady`). Remote must not be worse;
   ideally it kills the cold start entirely, because a deterministic image can bake
   the trust/dev-channel state the menus ask about.
2. **Subscription lane works.** When Settings selects the user's Claude login, the
   remote session must bill against the subscription, not an API invoice. No
   provider brokers this — it is our integration either way.
3. **Two-way messaging keeps working.** `sendToSession()` into the session, Stop-hook
   mirroring out to the inbox, `deliverWithRetry`'s semantics, the unread badge —
   none of this may regress. The bridge is the product; the sandbox is plumbing.
4. **Local-first posture.** The Mac's SQLite stays the source of truth for the inbox.
   No third-party cloud in the message path beyond the sandbox itself; transport
   rides the SYNC-DESIGN hub on the user's tailnet where possible.

Non-goal: multi-user anything. This is one person's agents on one person's account.

## 2. Provider comparison

### Cloudflare (Workers / Containers + Sandbox SDK)

Plain Workers are out categorically — workerd runs V8 isolates with no processes, no
PTYs, no real filesystem; `child_process` is a stub. Any Cloudflare answer is
**Containers** (Firecracker-style microVMs behind Durable Objects, Sandbox SDK beta).

That path genuinely works: full Linux, PTY over WebSocket since Feb 2026, exposed
ports for the bridge, `mountBucket()` for R2-backed persistence, and an official
"Claude Code on a Sandbox" template (batch-only) plus moltworker proving the
long-lived-agent pattern (labeled proof-of-concept). Subscription lane works via
`CLAUDE_CODE_OAUTH_TOKEN` as a secret.

The dealbreakers for *our* shape: a slept container wakes in a claimed 1–3s but a
commonly observed 3–15s, with a **wiped filesystem and dead processes** — tmux and
claude do not hibernate, they are killed, so every wake is a full resume flow from
R2-mounted state. Avoiding that means staying warm at ~$0.13/hr (≈$95/mo per
session). No region pinning, hosts restart "irregularly" with no uptime guarantee.
Cloudflare's economics assume disposable work; ours is a resident session.

**Verdict: capable but architecturally hostile. Pass.**

### E2B

Firecracker microVMs with the three primitives that map directly onto what we built:

- **Full-memory pause/resume.** Pause ≈ 4s/GiB, **resume ≈ 1s, with tmux, the bridge,
  and the claude process alive exactly where they were**. Paused sandboxes keep
  indefinitely at storage-only cost; `autoPause` on idle timeout. This is our
  dormancy model (`reviveSession`) implemented at the VM layer — but without losing
  the process, so no `--resume`, no resume-summary menu, no re-babysitting.
- **Custom templates whose start command is captured *running* in the snapshot** —
  node + tmux + claude + bridge already booted at template build time, so a fresh
  create (~150ms claimed, 200–500ms budgeted end-to-end) lands on a live session.
- **PTY API with reconnect** (`pty.connect(pid)`), so terminal attach survives
  network drops. There is also an official prebuilt Claude Code template.

Costs and caveats: **24h hard lifetime cap (Pro)** forces a pause/resume state
machine — our app manages the clock. Ports are auto-exposed as **public HTTPS URLs
with no auth**; the bridge token becomes the only lock unless we adopt E2B's secured
access. Pro is a **$150/mo floor** (Hobby's 1h cap is unusable), plus ~$1/day per
active 2vCPU session; a paused session is effectively free.

**Verdict: best capability fit. The pause/resume-with-memory primitive is the one
feature that makes "fast" true for a stateful session rather than marketing.**

### Daytona

OCI containers (shared host kernel — weaker isolation than Firecracker, relevant
since we run `--dangerously-skip-permissions`), sub-90ms creation claimed (~200ms
observed; assumes cached images), **no lifetime cap**, warm pools of pre-booted
sandboxes, reconnectable PTY, and preview URLs (`https://{port}-{id}...` +
`x-daytona-preview-token`) that map almost 1:1 onto our `{port, token}` discovery
scheme. Pay-as-you-go: a 2vCPU/4GiB sandbox ≈ **$0.17/hr running, ~$0.001/hr
stopped**, $200 signup credit, no monthly floor.

The catches: **no memory snapshots for containers** — stop/start preserves the
filesystem but kills tmux/claude/PTYs, so every restart is `claude --resume` plus
menu handling, i.e. exactly our local revive flow, just remote. **Auto-stop fires on
SDK inactivity even with processes running** (15min default; set `autoStopInterval:
0` and pay, or build keepalive). Preview tokens reset on restart; WebSocket behavior
through the proxy is undocumented — must verify. The production codebase went closed
source in June 2026; no self-host escape hatch.

**Verdict: best-shaped platform economics (persistent, unlimited-duration, cheap
when stopped), but resume ≠ resume — it re-runs our slowest, most fragile local
path on every wake.**

### Summary

| | Cloudflare Containers | E2B | Daytona |
|---|---|---|---|
| Isolation | microVM | microVM | container (shared kernel) |
| Warm resume of live session | No — processes killed on sleep | **Yes — ~1s, memory intact** | No — FS only, re-`--resume` |
| Fresh create latency | 1–3s claimed / 3–15s observed | ~150ms claimed / 200–500ms real | ~90ms claimed / ~200ms real |
| Lifetime cap | none, but hosts restart at will | **24h** (pause/resume cycles) | none |
| Inbound to bridge | expose/tunnel, internet-reachable | public HTTPS + our token | preview URL + provider token |
| PTY / attach | WS terminal | PTY + reconnect | PTY + reconnect |
| Subscription lane | env secret, works | env at create, works | env at create, works |
| Cost, one mostly-idle session | ~$95/mo warm, or slow resume | **$150/mo floor** + ~$1/day active | ~$0.17/hr active, ~free stopped |
| Sharpest flaw | sleep = wiped FS + dead procs | Pro price floor; public ports | restart kills claude; auto-stop |

## 3. Subscription auth remotely

**The mechanism that works:** `claude setup-token`, run **on the Mac** where a
browser exists. It performs the same OAuth flow as `/login` and prints a long-lived
(~1 year) `sk-ant-oat01-...` token, saved nowhere. We inject it into the sandbox as
`CLAUDE_CODE_OAUTH_TOKEN` at create time, as a secret — never baked into the image.
Requires Pro/Max/Team/Enterprise; usage draws from the subscription's 5-hour and
weekly caps, shared with local sessions. Zero auth latency at boot, no interactive
login to automate. ([Claude Code auth docs](https://code.claude.com/docs/en/authentication))

What we deliberately do **not** do: copy `~/.claude/.credentials.json` (or the macOS
Keychain blob) into the container. It works mechanically, but two hosts refreshing
one refresh token is fragile and unsupported, and macOS keeps it in the Keychain
anyway. `setup-token` is the documented headless path.

**Traps, from the auth precedence rules:**

- Precedence puts `ANTHROPIC_API_KEY` **above** `CLAUDE_CODE_OAUTH_TOKEN`. A stray
  API key in the image silently hijacks the subscription lane. The supervisor must
  assert the lanes are mutually exclusive: subscription → OAuth token set, API vars
  provably unset; api-key → the reverse.
- `--bare` mode does not read the OAuth token at all. If we ever reach for it to
  shave startup, the subscription lane breaks. Don't.
- The token is a **1-year bearer credential with no CLI revocation** (`/logout`
  doesn't revoke server-side; list/revoke are open feature requests). Practical
  revocation is the web console. Treat leakage as account compromise.

**Terms of service.** The Feb 2026 clarification bans subscription OAuth tokens in
anything that isn't Claude Code or claude.ai — third-party harnesses, Agent SDK
loops, shared accounts. Our case — the official `claude` binary, run by the account
owner, in a container the account owner controls — is on the permitted side, and is
consistently read that way for VPS/CI use. Two rules keep us there: the app never
calls the API with the OAuth token itself (it only launches `claude`), and one
stable datacenter IP, one user, no account sharing. Residual risk is nonzero —
Anthropic monitors usage patterns and the line is theirs to move — so this is a risk
we document, not one we can engineer away.

**API-key fallback, per lane.** Settings lane "api-key" injects `ANTHROPIC_API_KEY`
only. No expiry ceremony, console-revocable, no ToS ambiguity; cost is metered
(single-digit $/day for chat-style use with caching, but heavy coding sessions can
blow past the subscription's amortized price). The lane switch is a sandbox env
change plus session restart — nothing structural.

## 4. What breaks, and the design that fixes it

The current architecture assumes the session and the app share a machine. Audit of
`agents.ts`, `bridge.ts`, `agentPlugin.ts`, and the Stop hook against a remote
sandbox:

| # | Local assumption | Remote replacement |
|---|---|---|
| 1 | Bridge writes replies straight into the app's SQLite (`CLIPMD_DB`) | Bridge POSTs `agent.*` messages to the sync hub; app applies them via its pull loop |
| 2 | Clipboard tools (`search_clipboard` etc.) query the same local DB | Hub read endpoints answer clip queries; `secret = 0` filtering stays server-side |
| 3 | Discovery file `{port,pid,token}` on local disk; `reachable = existsSync()` | Bridge registers with the hub on startup; liveness is its open connection |
| 4 | App POSTs to `http://127.0.0.1:{port}` | Inverted: bridge holds an **outbound** WebSocket to the hub; hub forwards down it |
| 5 | Stop hook runs Electron-as-node and requires better-sqlite3 from the app bundle | Dependency-free hook: read transcript, `fetch()` the turn to the hub |
| 6 | `endSession()` = `tmux kill-session` + `process.kill(pid)` | Supervisor in the sandbox owns spawn/kill/revive; app sends lifecycle commands |
| 7 | `waitForChatReady` drives local `tmux capture-pane`/`send-keys` | Mostly eliminated: trust + plugin state baked into the image; residue moves to the supervisor |
| 8 | Image clips passed as local absolute paths | Content-addressed blobs: Mac `PUT /blobs/<sha>`, bridge fetches into the workspace |
| 9 | Plugin installed by local `claude`; `.mcp.json` points at the Electron binary | Baked at image build; `.mcp.json` runs `node /opt/clipmd/bridge.mjs` (bridge bundled self-contained) |
| 10 | Per-session env via tmux `-e` (`sessionEnv()`) | Same vars in the sandbox-create request; `CLIPMD_DB` drops, `CLIPMD_HUB_URL` + token replace the discovery file |
| 11 | `remember` appends to a local memory file | Emit `memory.append` to the hub — SYNC-DESIGN §4 already defines it |
| 12 | Profile `cwd` is a local directory (`existsSync` gate) | Remote profiles carry a git URL/branch or a persistent volume; validation moves to the supervisor |
| 13 | SYNC-DESIGN §1 excludes `agent_sessions`/`agent_messages` from sync — "no other machine can talk to them" | Remote sessions invert the premise; hub gains an **agent relay role** (live push, not the LWW clip log). Invariant I4 is amended, not violated |

### The design

**A session backend abstraction.** `agents.ts` splits its transport out behind one
interface — `launch`, `send`, `revive`, `end`, `attachInfo`, `reachable` — with two
implementations: `local-tmux` (today's code, unchanged behavior) and
`remote-sandbox`. Profiles gain a `backend` field. Everything above the interface —
singleton sessions, `askAgent`, `deliverWithRetry`, `sendOrQueue`, the inbox,
dormancy policy — stays identical, because none of it actually cares where the
process lives. That is the test of the abstraction: the palette cannot tell.

**How the app reaches the bridge.** Not by exposing the bridge's port. All three
providers make an exposed port internet-reachable behind at best a bearer token, and
tokens rotate on restart on two of them. Instead the connection inverts: the bridge
(which already owns per-session env) opens an **outbound WebSocket to the sync hub**
(SYNC-DESIGN §5) and registers `{session_key, token}`. `sendToSession()` becomes a
POST to the hub; the hub forwards down the open socket; the bridge emits the same
`notifications/claude/channel` it does today. No inbound ports on the sandbox, auth
is tailnet + hub-held token, and the same channel works for a *local* session on a
different synced machine later — the relay is written once. The hub is reachable
from the sandbox over plain HTTPS via `tailscale serve`'s funnel or by joining the
sandbox to the tailnet (`tailscaled` in the image); tailnet-join is preferred — it
also gives `ssh <sandbox> -t tmux attach` for the palette's attach affordance.

**How replies land in the inbox.** The Stop hook is rewritten dependency-free (plain
node ≥18, no better-sqlite3): parse the transcript, POST the mirrored turn to the
hub as an `agent.message`. The hub stores it durably (the offline-tolerance the
local design got from SQLite-direct writes is preserved — the hub is the durable
inbox); the app's existing long-poll pull applies it into `agent_messages`. Dedupe
moves hub-side with a `(session_key, uuid)` unique index — the same idempotency
trick as `sync_messages`. Unread counts, `markRead`, the badge: untouched, they read
the same table they always did.

**How clip attachments travel.** `clipBody()`/`clipAskContext()` stop emitting
Mac-local paths for images. Text/OCR/description ride the message as today; for
pixels, the Mac does `PUT /blobs/<sha>` (SYNC-DESIGN §5's endpoint, shared), the
message references the sha, and the bridge fetches `GET /blobs/<sha>` into the
sandbox workspace, rewriting the reference to that sandbox-local path. Secret clips
are already refused before any of this (`sendClip` throws) — that check stays where
it is, on the Mac, before anything leaves it.

**Lifecycle.** On E2B: `autoPause` replaces the dormancy sweep's kill — pause on
idle, ~1s resume on the next ask, and `deliverWithRetry`'s existing 90s patience
absorbs the resume window with room to spare. The 24h cap is handled by a scheduled
pause/resume tick in the supervisor. On Daytona (fallback): stop/start maps onto
`reviveSession` — the supervisor runs `claude --resume` with the baked image
eliminating the trust menus, leaving only the resume-summary prompt to auto-answer.

## 5. Recommendation

**Build the backend abstraction first; target E2B; keep Daytona as the priced-in
fallback.** E2B is the only provider whose fast path is *actually* our fast path:
memory-intact pause/resume means the resident tmux + claude + bridge survives idle,
and resume beats even the local app's warm sessions. Daytona wins on cost floor
($0/mo vs $150/mo) and unlimited lifetime, but every wake replays our most fragile
code path. Cloudflare is a pass. The abstraction keeps the provider swappable — the
supervisor and hub protocol are provider-neutral; only ~a day of SDK glue differs.

Ordering note: milestones R1+ depend on the sync hub (SYNC-DESIGN M1) existing.
Remote agents should follow, not precede, sync M1.

### Milestones (~14–18 days after sync M1)

- **R0 — Backend seam (2d).** Extract the `SessionBackend` interface; `local-tmux`
  passes existing behavior unchanged. *Exit: no user-visible diff, palette and inbox
  identical.*
- **R1 — Hub agent relay (3d).** `agent.*` message family, bridge outbound-WS mode
  (`CLIPMD_HUB_URL`), registration/liveness, app-side send-via-hub. Testable
  entirely locally (bridge on the same machine, pointed at the hub). *Exit: a local
  session speaking through the hub is indistinguishable in the inbox.*
- **R2 — Image + hook (3d).** Sandbox image: node, claude, tmux, tailscaled, bundled
  bridge, plugin + trust state baked; dependency-free Stop hook POSTing to the hub;
  supervisor (spawn/kill/resume/env). *Exit: `docker run` locally, full round-trip
  ask → reply → inbox.*
- **R3 — E2B integration (3–4d).** Template build with start-command snapshot,
  create/pause/resume state machine, 24h-cap tick, secret injection per auth lane,
  attach via tailnet SSH. *Exit: ask from the palette reaches a paused sandbox and
  answers in <5s; lid-close survival demonstrated.*
- **R4 — Hardening (3–4d).** Blob attachment flow, delivery-failure surfacing for
  hub-down, lane-exclusivity assertions, token-rotation runbook, cost/usage line in
  Settings. Daytona spike (1d of R4) to keep the fallback honest. *Exit: a week of
  daily use on one remote agent with zero lost messages.*

### Top 3 risks

1. **The OAuth token is a 1-year, effectively non-revocable bearer credential
   sitting in a third-party cloud** — and the ToS line it lives behind is Anthropic's
   to redraw. Mitigation: secret-injection only (never in the image), console
   revocation runbook, API-key lane as a one-toggle escape, and the app never
   touches the token outside sandbox-create.
2. **Resume fidelity.** E2B pause/resume is the load-bearing claim; wall-clock jumps
   across resume interact with the 24h cap, hook timing, and token-expiry math, and
   the Daytona fallback re-exposes menu babysitting remotely. Mitigation: R3 exit
   criteria test resume explicitly; `waitForChatReady`-equivalent stays in the
   supervisor as a safety net even on E2B.
3. **The hub becomes a hard dependency in the message path.** Today a bridge write
   is a local SQLite insert that cannot fail invisibly; remotely, hub-down means
   silent agents. Mitigation: same treatment as sync risk #2 — visible status,
   cursor-stall alerts, and the hook queues turns locally in the sandbox for replay
   when the hub returns.

## 6. References

- [Claude Code authentication / setup-token](https://code.claude.com/docs/en/authentication)
- [E2B persistence (pause/resume)](https://e2b.dev/docs/sandbox/persistence) · [E2B Claude Code template](https://e2b.dev/docs/agents/claude-code) · [E2B pricing](https://e2b.dev/pricing)
- [Daytona snapshots & warm pools](https://www.daytona.io/docs/en/snapshots/) · [Daytona preview URLs](https://www.daytona.io/docs/en/preview-and-authentication/) · [Daytona pricing](https://www.daytona.io/pricing)
- [Cloudflare Containers FAQ (cold start, persistence)](https://developers.cloudflare.com/containers/faq/) · [Claude Code on Sandbox tutorial](https://developers.cloudflare.com/sandbox/tutorials/claude-code/) · [moltworker](https://github.com/cloudflare/moltworker)
- [The Register — Anthropic's OAuth third-party clarification](https://www.theregister.com/2026/02/20/anthropic_clarifies_ban_third_party_claude_access/)
- docs/SYNC-DESIGN.md §4–5 — the hub, message catalog, and blob store this design extends.
