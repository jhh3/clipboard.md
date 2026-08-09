# clipboard.md — Cross-Machine Sync Design

*Drafted 2026-08-09 from the sync feasibility study, grounded against the code as of
`2b94911`. Companion to DESIGN.md; same rule applies: decisions come with reasons.*

## 1. Goal & non-goals

**Syncs:** clips (text/link/color/code rows in `items`), images (content-addressed
`<sha>.png` blobs under `userData/data/images`), notes (`items` rows with
`kind='note'`), and assistant memory (the `assistant-memory.md` Recent-tail entries
plus the consolidated file). Between the user's own machines over their tailnet,
offline-tolerant, no third-party cloud.

**Never syncs, by design:**

- **Secret clips** (`secret = 1`). A clipboard manager syncing credentials is the
  entire prior-art disaster genre (KDE Connect shipping password-manager clips to
  phones; Maccy's Handoff cross-pollination). Enforced structurally — see §7.
- **Agent sessions and messages** (`agent_sessions`, `agent_messages`). A session IS
  a machine-local tmux process with a bridge MCP attached (db.ts's own words: "we
  cannot address the ones we did not create"). Syncing the rows would produce an
  inbox full of agents no other machine can talk to.
- **Settings** (`settings.json`). Per-machine paths, hotkeys, poll intervals — and
  the sync configuration itself has to live somewhere that doesn't sync.
- **Derived state**: `items_fts`, `items_vec`, `enrich_queue`, `note_links`,
  `sessions` (capture sessions), thumbnails-as-index. All locally recomputable;
  FTS is maintained by the `items_ai/au/ad` triggers, `note_links` by `syncLinks()`,
  vectors by the local embedder. Syncing recomputable state buys conflicts and
  version-skew (different `EMBEDDING_DIM`, different FTS tokenizers) for nothing.

## 2. Architecture decision

**Chosen: an Actual-Budget-style append-only message log** — per-field LWW messages
`{entity uuid, column, value}` ordered by a hybrid logical clock, written to a local
outbox in the same transaction as the data change, relayed through a nearly-dumb hub
on the always-on Linux box, exposed over the tailnet with `tailscale serve`. The
reference implementation is jlongster's crdt-example-app (see refs, §11); our data is
*easier* than Actual's because clips are append-only content-hashed events and images
are content-addressed blobs.

Why the alternatives lost:

- **cr-sqlite** is the architecturally-correct answer (CRDT tables inside SQLite,
  works with better-sqlite3) that we cannot bet on: effectively unmaintained (last
  release v0.16.3, Jan 2024; the author moved to Rocicorp). Worse, crr tables forbid
  AUTOINCREMENT rowid PKs and non-PK UNIQUE constraints — `items` has both
  (`id INTEGER PRIMARY KEY AUTOINCREMENT`, `idx_items_hash` UNIQUE) — and virtual
  tables can't be crrs, so FTS5/vec stay local anyway. We'd rebuild our schema to
  adopt an abandoned dependency.
- **ElectricSQL** post-rewrite is a read-path sync engine out of a *mandatory
  Postgres*; the write path is explicitly your problem and SQLite demotes to a cache.
  That inverts local-first — the source of truth leaves the laptop. Not a candidate.
- **PowerSync** is mature but wants a backend database, a sync service, and your own
  write API — three server components — and turns client tables into views over a
  schemaless JSON store. An inverted, operations-heavy architecture for one
  engineer's three machines.
- **Turso/libSQL embedded replicas** forward writes to the primary (connectivity
  required for writes); offline-writes is beta with "no durability guarantees"; it
  replaces the better-sqlite3 driver we've tuned (§db.ts pragmas), and the company is
  mid-pivot to a SQLite rewrite whose FTS is Tantivy, not FTS5. Too much churn under
  our storage layer.
- **Raw Syncthing on the DB file** corrupts (sqlite.org How To Corrupt §1.2–1.4;
  syncthing #4242; CopyQ #618/#1244 is the cautionary tale of shipping this anyway).
  Tonsky's per-device append-only chunk-file pattern over Syncthing works, but needs
  Syncthing on every machine, still wants an always-on node, and iOS is a dead end.
  Kept as a fallback *transport* for the message log, nothing more.

## 3. Data model changes

Two migrations appended to the `MIGRATIONS` array in `src/main/store/db.ts` (pure SQL
strings, `user_version`-gated, same as the existing six).

**Migration: stable identity + device identity.** Rows need an identity that isn't
the machine-local AUTOINCREMENT id. Backfill is pure SQL so it fits the migration
style:

```sql
ALTER TABLE items ADD COLUMN uuid TEXT;
UPDATE items SET uuid = lower(hex(randomblob(16)));
CREATE UNIQUE INDEX idx_items_uuid ON items(uuid);
INSERT INTO meta (key, value)
  SELECT 'device_id', lower(hex(randomblob(8)))
  WHERE NOT EXISTS (SELECT 1 FROM meta WHERE key = 'device_id');
```

New rows get a uuid at insert time in `upsertClip()` / `createNote()`.

**Migration: the outbox.**

```sql
CREATE TABLE sync_messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,  -- local arrival order
  device_id TEXT NOT NULL,                -- origin device
  hlc TEXT NOT NULL,                      -- see format below
  type TEXT NOT NULL,                     -- 'clip.add', 'field', ... (§4)
  entity_uuid TEXT NOT NULL,              -- items.uuid this message is about
  payload TEXT NOT NULL,                  -- JSON
  pushed_at INTEGER,                      -- NULL = still owed to the hub
  applied_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_sync_messages_id ON sync_messages(device_id, hlc);
CREATE INDEX idx_sync_messages_outbox ON sync_messages(pushed_at)
  WHERE pushed_at IS NULL;
CREATE INDEX idx_sync_messages_entity ON sync_messages(entity_uuid, type);
```

One table serves as outbox (rows with `pushed_at IS NULL`), apply-dedupe (the unique
`(device_id, hlc)` index makes apply idempotent: `INSERT OR IGNORE`, skip if ignored),
and per-field LWW register (latest `hlc` for an `(entity_uuid, column)` pair wins).
Remote-origin messages are inserted with `pushed_at` set — the hub already has them.
The pull cursor lives in `meta` under key `sync_cursor`.

**HLC format:** `<wallclock ms, 15 digits zero-padded>-<counter, 4 hex>-<device_id>`.
Fixed width makes HLC comparison plain string comparison, which makes the LWW query
a `MAX(hlc)`. Port of the ~200-line clock from crdt-example-app, with tests: send =
max(wall, last)+tick, receive = max(wall, local, remote)+tick, drift clamp at 5 min.

## 4. Message catalog

| Type | Payload | Conflict rule |
|---|---|---|
| `clip.add` | full row: kind, content (text kinds), `blob_sha` (images), html, preview, hash, source_app, created_at, char_count, secret is **always 0** (§7), `derived_from` as parent *uuid*, derived_via, thumb (images only — see §6) | Append-only. Converges by content identity: text kinds by `hash` (same `contentHash()` on every machine), images by `blob_sha`. If a matching row already exists locally, no insert — record the incoming uuid as an alias for the existing row and take `created_at = min` |
| `clip.copy` | `{ at }` | `last_copied_at = max(at, current)`; `copy_count += 1` per distinct message — the `(device_id, hlc)` unique index makes this an exact G-counter |
| `field` | `{ column, value }` for: pinned, tags, title, auto_title, content_class, ocr_text, description, language, enriched_at | Per-column LWW by HLC. One machine pays enrichment; results propagate as fields. `embedded_at` and `thumb` are **excluded** — vectors are local, so syncing `embedded_at` would tell the local embedder work is done that never happened |
| `clip.delete` | `{}` | Tombstone by uuid. Delete beats concurrent field writes. Applied via `purgeItems()` so vectors and last-reference image files go too; hub GCs the blob when no live row references it |
| `clip.redact` | `{}` | `clip.delete` plus: hub hard-deletes every stored message payload for this uuid and its blob, peers apply inside `secureDeleteNow()`. Emitted when `secret` flips 0→1 after the row already synced (§7) |
| `note.add` | `{ title, content, created_at }` | Identity is the uuid — notes deliberately never dedupe by hash (`createNote()` salts the hash for exactly this reason). Always insert |
| `note.update` | `{ title, content, updated_at }` | Whole-document LWW by HLC. A concurrent loser is not discarded: it is re-created as a new note titled "<title> (conflicted copy, <device>)" — Joplin's answer. Text CRDTs are overkill for one person's notes; losing an edit silently is the only unacceptable outcome |
| `memory.append` | `{ line }` — one dated `- YYYY-MM-DD: fact.` entry | Union. Idempotent by message id; applied by appending to the `## Recent (unconsolidated)` section via `applyOps()` (skip if the exact line is already present) |
| `memory.consolidated` | `{ text }` — the whole file | LWW, but only the hub machine ever emits it (§5): it is the sole runner of `consolidateMemory()`, so there is exactly one writer and LWW degenerates to "latest consolidation wins" |

Apply-side remapping: `derived_from` arrives as a uuid and is remapped to the local
`items.id` (NULL if the parent isn't here — same semantics as the existing
`ON DELETE SET NULL`). `session_id` is never carried: capture sessions are local.

## 5. The hub

A `packages/sync-server` workspace package (add `packages/*` to
`pnpm-workspace.yaml`, which today lists only `'.'`), sharing `@shared/types`.
Headless Node + better-sqlite3, ~300 lines, running on the always-on Linux box.

**Storage:** one SQLite file — `messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,
device_id, hlc, type, entity_uuid, payload, UNIQUE(device_id, hlc))` — plus a
content-addressed blob directory mirroring the client's `data/images` layout.

**API, five endpoints:**

1. `POST /messages` — batch append. Idempotent via the `(device_id, hlc)` unique
   index; returns the server `seq` of the last accepted message.
2. `GET /messages?after=<seq>` — cursor pull, long-poll (25s hold) so pushes reach
   idle peers in seconds without a poll storm.
3. `PUT /blobs/<sha>` — image upload; verifies the sha, no-op if present.
4. `GET /blobs/<sha>` — lazy image fetch.
5. `POST /snapshot` — compaction: fold the log below a seq into a snapshot, drop
   redacted payloads, GC unreferenced blobs (M3).

**Deployment:** bind 127.0.0.1, expose with `tailscale serve --bg <port>`. That buys
WireGuard encryption, tailnet-only reachability, HTTPS, and `Tailscale-User-Login`
identity headers without writing an auth system; a `grants` rule scoped to
`autogroup:self` restricts it to the user's own devices.

**Why no Merkle trie:** Actual needs one because peers compare logs pairwise. With a
single hub there is one total order — the server-assigned `seq` — and "what am I
missing" is `?after=<my cursor>`. A cursor integer replaces the entire
trie-diff protocol. The trade is that the hub is a required intermediary; on a
tailnet with one always-on box, that is the topology we already have.

**Second hub role:** it runs the app headless (or a slim runner) as the **sole
consolidator** — the only machine where `startMemorySchedule()` runs
`consolidateMemory()` over the unioned Recent tail, publishing
`memory.consolidated`. Other machines still run phase-1 fact extraction over their
own `agent_messages` (that material is machine-local) and emit the results as
`memory.append`. One writer means the mem0-style reconcile pass never races itself.

## 6. Client loop

**Emit hooks** — in the store layer, not capture, so every caller (capture, IPC
paste-as, `transforms.ts` derived clips) is covered. Each hook writes its message in
the same transaction as the data change; the outbox cannot disagree with the tables.

- `items.ts`: `upsertClip()` emits `clip.add` on insert / `clip.copy` on the bump
  path — both **only when the row has `secret = 0`**; `setPinned()` emits `field`;
  `updateEnrichment()` emits `field` per changed column; `deleteItem()` emits
  `clip.delete`. `purgeItems()` itself does **not** emit: `applyRetention()` calls it
  for local housekeeping, and retention expiry on one machine must not delete history
  everywhere (retention is per-machine policy, deletion is a user intent).
- `notes.ts`: `createNote()` emits `note.add`; `updateNote()` emits `note.update`.
- The bridge's `remember` append emits `memory.append`.

**Apply path** — `src/main/store/sync.ts`, `applyMessage()`. Applies through the
normal INSERT/UPDATE statements against `items`, on purpose: the `items_ai/au`
triggers keep FTS correct, `syncLinks()` runs on applied notes, and the local
embedder picks the row up via `itemsNeedingEmbedding()` (its `embedded_at IS NULL`
filter — which is why `embedded_at` never syncs). Apply does **not** call
`enqueueEnrichment()`: the origin machine enriches and the results arrive as `field`
messages. An `applying` flag suppresses the emit hooks so applied writes don't echo
back into the outbox.

**Images:** `clip.add` carries `blob_sha` + dimensions + the in-row `thumb` data URL.
Carrying the thumb (tens of KB) is a deliberate exception to "derived state never
syncs": it is what makes lazy blob fetch tolerable — the list renders real thumbnails
immediately, and the full PNG is fetched from `GET /blobs/<sha>` on first view or in
idle background, written to the local `imagesDir()`, with `content` set to the
*local* absolute path (see the callout in §10 — paths are machine-local).

**Cadence:** push outbox on a 5s debounce after any emit; pull via long-poll
continuously while online; both immediately on `powerMonitor` resume and network
reconnect (the wake catch-up — most sync happens right after opening the laptop).

**Status UI:** a tray/palette line — "Synced 12s ago · 3 pending" — plus an explicit
error state when the hub is unreachable or the cursor stalls. Silent sync failure is
risk #2 (§10); status is a feature, not chrome.

**Live clipboard follow** (machine B's clipboard is set when machine A copies) is a
separate, off-by-default toggle in M3. CopyQ users' loudest complaint was conflating
history sync with clipboard takeover.

## 7. Privacy invariants

Framed as testable assertions; each gets a real test before its milestone ships.

- **I1 — Secrets never enter the outbox.** Every emit site filters on `secret = 0`;
  there is no code path from a `store-secret` verdict (`runFilters()` /
  `detectSecret()` in `src/main/capture/filters.ts`, re-run in `ipc.ts` paste-as and
  `transforms.ts` derived clips) to a `sync_messages` row. *Test: capture an
  `AKIA...` clip, assert the outbox is empty; same for a derived clip inheriting
  `secret` from its source.*
- **I2 — Flipping secret after capture redacts everywhere.** Today `secret` is
  write-once at capture (no toggle exists — the `items_au` trigger lists `secret`
  but nothing sets it; see §10). Sync makes a future toggle, and any improved
  heuristic re-scan, into a distributed problem: the clip may have already synced.
  Rule: any 0→1 transition on a row that has a uuid emits `clip.redact`; the hub
  purges stored payloads and the blob; every peer purges via `secureDeleteNow()`.
  The window between capture-sync and a later heuristic flag is designed-in — it
  gets measured, not hand-waved. *Test: sync a clip, flip it, assert row+blob+hub
  payloads are gone on all three parties.*
- **I3 — User deletes propagate; retention doesn't.** `deleteItem()` →
  `clip.delete` → applied via `purgeItems()` on every peer within one sync cycle;
  the hub GCs the blob when the last referencing row tombstones. `applyRetention()`
  never emits. *Test: delete an image clip on A, assert file gone on B and blob gone
  on hub; expire a clip by retention on A, assert it survives on B.*
- **I4 — The excluded tables stay excluded.** No message type carries
  `agent_sessions`, `agent_messages`, `settings.json`, `items_fts`, `items_vec`,
  `enrich_queue`, `sessions`, or `note_links` content. *Test: schema-level assertion
  over the message catalog + a fuzz pass over payloads.*

## 8. Phone story

The hub API is exactly what a phone needs, and it is the decisive argument for an
HTTP hub over Syncthing (whose iOS story is a dead end). With Tailscale iOS
installed, the hub URL is reachable from the phone with zero additional auth work:

- **Capture:** an iOS Shortcut on the share sheet POSTs a `clip.add` message
  (text-only, `device_id: phone`, HLC built from wall clock + counter 0). It appears
  on every machine like any other clip.
- **Read:** a Shortcut (or the hub serving one static HTML page) hits
  `GET /messages?after=...` for a read-only recent-clips view. No app-store client,
  no sync state on the phone.

## 9. Milestones

Estimate: **15–17 days** total.

- **M0 — Foundation (3d).** uuid migration + backfill, `device_id`, HLC port with
  unit tests, `sync_messages`, emit hooks, `applyMessage()` with the `applying`
  guard. *Exit: a message log replayed into a fresh DB reproduces the source DB's
  items, FTS answers match, embedder queue picks up applied rows; I1 test green.*
- **M1 — Clips + images, two machines (5–6d).** Hub package, cursor API, blob store,
  push/pull with wake catch-up, hash-dedupe ingest with uuid aliasing, lazy blobs,
  `clip.redact`, tombstone GC, `tailscale serve` deployment, status UI. Ship
  text-only first; flip images on once text soaks clean. *Exit: two real machines in
  daily use for a week with zero divergence (nightly full-table checksum compare),
  I2/I3 tests green.*
- **M2 — Notes + memory (4d).** `note.add`/`note.update` LWW with conflicted-copy
  recovery, `memory.append` events, hub consolidator role, per-item "don't sync
  this". *Exit: concurrent edits to one note on two offline machines produce the
  winner plus a conflicted copy, never a silent loss; Recent-tail entries written on
  A appear in B's consolidated file.*
- **M3 — Hardening (3–4d).** `POST /snapshot` compaction + reset-from-snapshot,
  live-follow toggle, phone Shortcut endpoint polish, optional E2E payload
  encryption (hub stores ciphertext, key never leaves clients). *Exit: log compacts
  below a size budget with a fresh client bootstrapping from snapshot; phone
  round-trip demo.*

## 10. Risks

1. **Privacy regressions in the secret/delete paths.** Every prior-art fury had this
   shape. Mitigation: the §7 invariants are tests, not prose; they run in CI from M0
   on; the heuristic-fires-late window (I2) is instrumented so its real frequency is
   known. Additionally three study assumptions did **not** survive contact with the
   code and are corrected here: **(a)** for images, `items.hash` is
   `contentHash('image', content)` where `content` is the machine-local *absolute
   file path* — so images do **not** converge by `items.hash` across machines; they
   converge by `blob_sha`, and `content` is rewritten to the local path on apply.
   **(b)** No secret toggle exists today; `clip.redact` designs ahead of one.
   **(c)** `purgeItems()` is shared by user deletes *and* `applyRetention()` — a
   naive emit there would propagate retention expiry as deletion everywhere, so the
   emit lives in `deleteItem()` only.
2. **Silent sync failure eroding trust** (Paste's iCloud races, CopyQ's lazy
   refresh). Mitigation: visible status with a pending count, aggressive wake/resume
   catch-up, and a cursor-stall alert (cursor unchanged while outbox non-empty for
   N minutes → surface an error, don't log it).
3. **Merge edge cases and log growth.** Hash-identity meeting mutable fields (uuid
   aliasing), notes LWW losing concurrent edits (hence conflicted copies, never
   discard), and an unbounded log. Mitigation: property tests replaying shuffled
   message orders must converge to identical DBs; snapshot/compaction lands in M3
   before the log is big enough to hurt.

## 11. References

- Long: [Using CRDTs in the wild](https://archive.jlongster.com/using-crdts-in-the-wild) — the Actual sync design this follows.
- [clintharris/crdt-example-app_annotated](https://github.com/clintharris/crdt-example-app_annotated) — annotated reference implementation (NOTES.md).
- Prokopov: [Local, first, forever](https://tonsky.me/blog/crdt-filesync/) — the Syncthing-transport fallback pattern.
- [How To Corrupt An SQLite Database File](https://www.sqlite.org/howtocorrupt.html) §1.2–1.4 — why the DB file itself never syncs.
- [Tailscale serve](https://tailscale.com/kb/1312/serve) — the deployment mechanism.
