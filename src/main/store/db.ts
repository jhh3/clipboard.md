import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'
import { join } from 'path'
import { mkdirSync, existsSync } from 'fs'

export const EMBEDDING_DIM = 384 // bge-small-en-v1.5

let db: Database.Database | null = null
let vecAvailable = false

const MIGRATIONS: string[] = [
  `
  CREATE TABLE items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    content TEXT NOT NULL,
    html TEXT,
    hash TEXT NOT NULL,
    preview TEXT NOT NULL,
    thumb TEXT,
    width INTEGER,
    height INTEGER,
    source_app TEXT,
    created_at INTEGER NOT NULL,
    last_copied_at INTEGER NOT NULL,
    copy_count INTEGER NOT NULL DEFAULT 1,
    pinned INTEGER NOT NULL DEFAULT 0,
    auto_title TEXT,
    tags TEXT NOT NULL DEFAULT '[]',
    content_class TEXT,
    ocr_text TEXT,
    description TEXT,
    language TEXT,
    derived_from INTEGER REFERENCES items(id) ON DELETE SET NULL,
    derived_via TEXT,
    secret INTEGER NOT NULL DEFAULT 0,
    char_count INTEGER NOT NULL DEFAULT 0,
    enriched_at INTEGER,
    embedded_at INTEGER
  );
  CREATE UNIQUE INDEX idx_items_hash ON items(hash);
  CREATE INDEX idx_items_last_copied ON items(last_copied_at DESC);
  CREATE INDEX idx_items_pinned ON items(pinned) WHERE pinned = 1;
  CREATE INDEX idx_items_class ON items(content_class);

  CREATE VIRTUAL TABLE items_fts USING fts5(
    content, auto_title, tags, ocr_text, description,
    content='items', content_rowid='id', tokenize='unicode61'
  );

  CREATE TRIGGER items_ai AFTER INSERT ON items BEGIN
    INSERT INTO items_fts(rowid, content, auto_title, tags, ocr_text, description)
    VALUES (new.id, CASE WHEN new.secret = 1 THEN '' ELSE new.content END,
            new.auto_title, new.tags, new.ocr_text, new.description);
  END;
  CREATE TRIGGER items_ad AFTER DELETE ON items BEGIN
    INSERT INTO items_fts(items_fts, rowid, content, auto_title, tags, ocr_text, description)
    VALUES ('delete', old.id, CASE WHEN old.secret = 1 THEN '' ELSE old.content END,
            old.auto_title, old.tags, old.ocr_text, old.description);
  END;
  CREATE TRIGGER items_au AFTER UPDATE OF content, auto_title, tags, ocr_text, description, secret ON items BEGIN
    INSERT INTO items_fts(items_fts, rowid, content, auto_title, tags, ocr_text, description)
    VALUES ('delete', old.id, CASE WHEN old.secret = 1 THEN '' ELSE old.content END,
            old.auto_title, old.tags, old.ocr_text, old.description);
    INSERT INTO items_fts(rowid, content, auto_title, tags, ocr_text, description)
    VALUES (new.id, CASE WHEN new.secret = 1 THEN '' ELSE new.content END,
            new.auto_title, new.tags, new.ocr_text, new.description);
  END;

  CREATE TABLE enrich_queue (
    item_id INTEGER PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    queued_at INTEGER NOT NULL
  );

  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `,
  `
  ALTER TABLE items ADD COLUMN session_id INTEGER;
  CREATE INDEX idx_items_session ON items(session_id);
  CREATE TABLE sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT,
    started_at INTEGER NOT NULL,
    ended_at INTEGER NOT NULL
  );
  `,
  `
  CREATE INDEX IF NOT EXISTS idx_items_kind ON items(kind);
  CREATE INDEX IF NOT EXISTS idx_items_secret ON items(secret);
  `,
  // Notes.
  //
  // Notes are items with kind='note', not a table of their own. That one decision
  // inherits FTS5, the sqlite-vec embeddings, tags, pinning, sessions, enrichment and
  // the whole palette for free; a separate table would mean reimplementing every one
  // of them. What notes add over a clip is a user-authored title and mutability.
  //
  // items_fts has to be rebuilt rather than altered because FTS5 columns are fixed at
  // creation. 'rebuild' repopulates it from the content table, so nothing is lost.
  `
  ALTER TABLE items ADD COLUMN title TEXT;
  ALTER TABLE items ADD COLUMN updated_at INTEGER;

  DROP TRIGGER IF EXISTS items_ai;
  DROP TRIGGER IF EXISTS items_ad;
  DROP TRIGGER IF EXISTS items_au;
  DROP TABLE IF EXISTS items_fts;

  CREATE VIRTUAL TABLE items_fts USING fts5(
    content, title, auto_title, tags, ocr_text, description,
    content='items', content_rowid='id', tokenize='unicode61'
  );

  CREATE TRIGGER items_ai AFTER INSERT ON items BEGIN
    INSERT INTO items_fts(rowid, content, title, auto_title, tags, ocr_text, description)
    VALUES (new.id, CASE WHEN new.secret = 1 THEN '' ELSE new.content END,
            new.title, new.auto_title, new.tags, new.ocr_text, new.description);
  END;
  CREATE TRIGGER items_ad AFTER DELETE ON items BEGIN
    INSERT INTO items_fts(items_fts, rowid, content, title, auto_title, tags, ocr_text, description)
    VALUES ('delete', old.id, CASE WHEN old.secret = 1 THEN '' ELSE old.content END,
            old.title, old.auto_title, old.tags, old.ocr_text, old.description);
  END;
  CREATE TRIGGER items_au AFTER UPDATE OF content, title, auto_title, tags, ocr_text, description, secret ON items BEGIN
    INSERT INTO items_fts(items_fts, rowid, content, title, auto_title, tags, ocr_text, description)
    VALUES ('delete', old.id, CASE WHEN old.secret = 1 THEN '' ELSE old.content END,
            old.title, old.auto_title, old.tags, old.ocr_text, old.description);
    INSERT INTO items_fts(rowid, content, title, auto_title, tags, ocr_text, description)
    VALUES (new.id, CASE WHEN new.secret = 1 THEN '' ELSE new.content END,
            new.title, new.auto_title, new.tags, new.ocr_text, new.description);
  END;

  INSERT INTO items_fts(items_fts) VALUES('rebuild');

  -- Edges are implicit in the note body ([[wikilinks]]), the way Obsidian and
  -- SilverBullet do it; backlinks are just the reverse-adjacency view. to_id is
  -- nullable so a link to a note that doesn't exist yet is still recorded — that
  -- unresolved edge is what makes "create it from the link" possible later.
  CREATE TABLE note_links (
    from_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    to_id INTEGER REFERENCES items(id) ON DELETE CASCADE,
    target_title TEXT NOT NULL,
    PRIMARY KEY (from_id, target_title)
  );
  CREATE INDEX idx_note_links_to ON note_links(to_id);
  CREATE INDEX idx_note_links_title ON note_links(target_title);
  CREATE INDEX IF NOT EXISTS idx_items_title ON items(title);
  `,
  // Agent sessions and the inbox they talk back through.
  //
  // Only sessions we spawned appear here, and that is the point: a session is ours
  // precisely because we started it with a bridge MCP attached, which is what makes
  // two-way messaging possible at all. `claude agents --json` can see every session
  // on the machine, but we cannot address the ones we did not create.
  //
  // Messages live in SQLite rather than in memory so the inbox survives an app
  // restart — an agent that answered a question while the app was closed must not
  // lose the answer. It is also how the bridge process (a separate stdio MCP server)
  // hands work to the app without either having to hold a socket open.
  `
  CREATE TABLE agent_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    -- Our own handle, also the tmux session name and bridge discovery key.
    key TEXT NOT NULL UNIQUE,
    profile TEXT NOT NULL,
    cwd TEXT NOT NULL,
    -- Claude's own session id, learned from 'claude agents --json' once it appears.
    session_id TEXT,
    pid INTEGER,
    title TEXT,
    -- starting | running | exited
    status TEXT NOT NULL DEFAULT 'starting',
    worktree TEXT,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    ended_at INTEGER
  );
  CREATE INDEX idx_agent_sessions_status ON agent_sessions(status);

  CREATE TABLE agent_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_key TEXT NOT NULL,
    -- inbound = we sent it to the agent; outbound = the agent sent it to us.
    direction TEXT NOT NULL,
    -- progress | question | done | failure | note: drives how the inbox renders it.
    kind TEXT NOT NULL,
    body TEXT NOT NULL,
    -- JSON blob of whatever the tool passed alongside the text.
    meta TEXT,
    created_at INTEGER NOT NULL,
    read_at INTEGER
  );
  CREATE INDEX idx_agent_messages_session ON agent_messages(session_key, created_at);
  CREATE INDEX idx_agent_messages_unread ON agent_messages(read_at) WHERE read_at IS NULL;
  `,

  // Remote session backends (E2B sandboxes). NULL backend means local tmux —
  // every pre-existing row. sandbox_id is the provider handle needed to
  // reconnect/kill the sandbox after an app restart.
  `
  ALTER TABLE agent_sessions ADD COLUMN backend TEXT;
  ALTER TABLE agent_sessions ADD COLUMN sandbox_id TEXT;
  `,

  // Ack cursor: the last message seq durably drained from a remote bridge. Its
  // own migration, NOT folded into the one above — that one already ran on
  // dev DBs, so an appended ALTER there would never execute.
  `
  ALTER TABLE agent_sessions ADD COLUMN outbox_cursor INTEGER NOT NULL DEFAULT 0;
  `
]

/**
 * Load the sqlite-vec extension, packaged or not.
 *
 * In a packaged build the module resolves to a path inside app.asar, which is a
 * bundle rather than a directory — dlopen can't read it, so the extension silently
 * failed to load and semantic search was disabled in the installed app while
 * working fine in dev. Native binaries live in app.asar.unpacked instead.
 */
function loadVecExtension(d: Database.Database): void {
  const candidates: string[] = []
  try {
    const p = (sqliteVec as unknown as { getLoadablePath?: () => string }).getLoadablePath?.()
    if (p) {
      const unpacked = p.replace(/app\.asar(?![.\w])/, 'app.asar.unpacked')
      // sqlite appends the platform suffix when the given path doesn't exist, so
      // offer both the exact file and the extension-less form.
      candidates.push(unpacked, unpacked.replace(/\.(so|dylib|dll)$/, ''))
    }
  } catch {
    /* fall through to the module's own loader */
  }

  for (const candidate of candidates) {
    try {
      d.loadExtension(candidate)
      vecAvailable = true
      return
    } catch {
      /* try the next candidate */
    }
  }
  try {
    sqliteVec.load(d)
    vecAvailable = true
  } catch (err) {
    // Semantic search degrades to keyword-only; everything else works.
    console.error('[db] sqlite-vec failed to load, semantic search disabled:', err)
  }
}

/** vec0 table lives outside migrations: created only when the extension loads.
 *  If the stored dimension differs (model change), drop and re-embed from scratch. */
function ensureVecTable(d: Database.Database): void {
  // Introspect the real declared dimension — meta keys can lie after upgrades.
  const tbl = d
    .prepare("SELECT sql FROM sqlite_master WHERE name = 'items_vec'")
    .get() as { sql: string } | undefined
  const declared = tbl ? Number(/FLOAT\[(\d+)\]/i.exec(tbl.sql)?.[1] ?? 0) : null
  if (declared !== null && declared !== EMBEDDING_DIM) {
    d.exec('DROP TABLE IF EXISTS items_vec')
    d.exec('UPDATE items SET embedded_at = NULL')
  }
  d.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS items_vec USING vec0(
    item_id INTEGER PRIMARY KEY,
    embedding FLOAT[${EMBEDDING_DIM}]
  )`)
  d.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('embedding_dim', ?)").run(
    String(EMBEDDING_DIM)
  )
}

/** Caller supplies the data directory (Electron main passes userData; tests pass a tmpdir). */
export function openDb(dataDir: string): Database.Database {
  if (db) return db
  const dir = dataDir
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'clipboard.db')
  const isNew = !existsSync(file)
  db = new Database(file)

  // page_size and auto_vacuum are only settable before the first table exists.
  if (isNew) {
    db.pragma('page_size = 8192') // SQLite: best throughput for blob-ish rows
    db.pragma('auto_vacuum = INCREMENTAL') // reclaim without a full VACUUM's 2x disk
  }
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  db.pragma('cache_size = -20000') // ~20MB page cache (default is 2MB)
  db.pragma('temp_store = MEMORY') // FTS5 ranking builds temp b-trees
  db.pragma('mmap_size = 268435456')
  // Overwrite deleted rows instead of leaving them readable in free pages: without
  // this, a password the user deleted stays recoverable in the database file.
  db.pragma('secure_delete = FAST')
  // Long-lived connection: SQLite asks for this on open, then periodically.
  db.pragma('optimize = 0x10002')

  loadVecExtension(db)

  const version = db.pragma('user_version', { simple: true }) as number
  if (version > MIGRATIONS.length) {
    // An older build opening a newer database would silently skip the migration
    // loop and then operate against a schema it doesn't understand.
    db.close()
    db = null
    throw new Error(
      `Database schema is version ${version} but this build only knows ${MIGRATIONS.length}. ` +
        'Run the newer version of clipboard.md; your data has not been touched.'
    )
  }
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db!.exec(MIGRATIONS[v])
      db!.pragma(`user_version = ${v + 1}`)
    })()
  }
  if (vecAvailable) ensureVecTable(db)
  return db
}

/**
 * Open the same database read-only, without running migrations. Used by the MCP
 * server, which may be an older binary than the running app: letting it migrate
 * (or worse, drop and rebuild the vector table) would corrupt the app's schema
 * underneath it.
 */
export function openReadOnlyDb(dataDir: string): Database.Database {
  if (db) return db
  db = new Database(join(dataDir, 'clipboard.db'), { readonly: true })
  db.pragma('busy_timeout = 5000')
  loadVecExtension(db)
  return db
}

export function getDb(): Database.Database {
  if (!db) throw new Error('DB not opened')
  return db
}

export function hasVec(): boolean {
  return vecAvailable
}

/**
 * Flush and close cleanly. Previously the process exited with the DB open, leaving
 * whatever sat in the WAL to be recovered on next start (and lost on a hard kill).
 */
export function closeDb(): void {
  if (!db) return
  try {
    db.pragma('wal_checkpoint(TRUNCATE)')
    db.pragma('optimize') // SQLite recommends this immediately before closing
  } catch (err) {
    console.error('[db] checkpoint/optimize on close failed:', err)
  }
  db.close()
  db = null
}

/** Periodic maintenance for a long-lived connection. */
export function maintainDb(): void {
  if (!db) return
  try {
    db.pragma('wal_checkpoint(TRUNCATE)')
    db.pragma('incremental_vacuum(500)')
    db.pragma('optimize')
  } catch (err) {
    console.error('[db] maintenance failed:', err)
  }
}

/**
 * Purge with forensic hygiene: used for explicit user deletes, where "delete"
 * has to mean the bytes are gone, not just unlinked from the b-tree.
 */
export function secureDeleteNow<T>(fn: () => T): T {
  if (!db) return fn()
  db.pragma('secure_delete = ON')
  try {
    return fn()
  } finally {
    db.pragma('secure_delete = FAST')
  }
}
