import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'
import { join } from 'path'
import { mkdirSync } from 'fs'

export const EMBEDDING_DIM = 256

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
  `
]

/** vec0 table lives outside migrations: created only when the extension loads. */
function ensureVecTable(d: Database.Database): void {
  d.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS items_vec USING vec0(
    item_id INTEGER PRIMARY KEY,
    embedding FLOAT[${EMBEDDING_DIM}]
  )`)
}

/** Caller supplies the data directory (Electron main passes userData; tests pass a tmpdir). */
export function openDb(dataDir: string): Database.Database {
  if (db) return db
  const dir = dataDir
  mkdirSync(dir, { recursive: true })
  db = new Database(join(dir, 'clipboard.db'))
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')

  try {
    sqliteVec.load(db)
    vecAvailable = true
  } catch (err) {
    // Semantic search degrades to keyword-only; everything else works.
    console.error('[db] sqlite-vec failed to load, semantic search disabled:', err)
  }

  const version = db.pragma('user_version', { simple: true }) as number
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

export function closeDb(): void {
  db?.close()
  db = null
}
