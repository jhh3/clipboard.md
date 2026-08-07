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
