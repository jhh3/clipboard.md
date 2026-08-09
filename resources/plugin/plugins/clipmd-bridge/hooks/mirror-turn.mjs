#!/usr/bin/env node
/**
 * Stop hook: mirror the turn that just finished into clipboard.md's inbox.
 *
 * Why this exists: the inbox previously only saw what the agent CHOSE to send
 * through a tool, so a plain reply — the normal case — was invisible. Asking the
 * model to always call a tool is not a fix; models forget, and you get the answer
 * twice. A hook fires whether or not the model cooperates.
 *
 * The MCP tools still matter and are not replaced. They carry MEANING a transcript
 * mirror cannot infer: `ask_question` means "blocked, waiting on you", which is what
 * drives the unread badge and the do-not-interrupt behaviour. The hook covers
 * visibility; the tools cover intent.
 *
 * TIMING, learned the hard way twice: the Stop hook can fire BEFORE claude flushes
 * the final assistant message to the transcript file. The first fix retried until
 * ANY assistant text appeared — which on every turn after the first immediately
 * found the PREVIOUS turn's reply, "deduped" it, and exited before the new reply
 * flushed. So the staleness check has to live INSIDE the retry loop: an entry we
 * have already mirrored keeps us waiting; only a NEW entry (or timeout) ends it.
 *
 * Deliberately dependency-free beyond the app's own better-sqlite3 — a hook runs in
 * claude's process tree, not ours, so everything it needs arrives via environment.
 *
 * Never blocks the session: any failure exits 0 quietly. A broken mirror must not
 * stop an agent from working.
 */
import { readFileSync } from 'fs'
import { createRequire } from 'module'

const KEY = process.env.CLIPMD_SESSION_KEY
const DB = process.env.CLIPMD_DB
const REQUIRE_FROM = process.env.CLIPMD_REQUIRE_FROM

function bail(db) {
  try {
    db?.close()
  } catch {
    /* already closed */
  }
  process.exit(0)
}

if (!KEY || !DB || !REQUIRE_FROM) bail()

let input = ''
try {
  input = readFileSync(0, 'utf8')
} catch {
  bail()
}

let hook
try {
  hook = JSON.parse(input)
} catch {
  bail()
}
if (!hook.transcript_path) bail()

/**
 * Last assistant text in the transcript, with its entry uuid.
 *
 * Only the final assistant message: mirroring every intermediate step would flood
 * the inbox with the tool chatter the user is reading the inbox to avoid.
 */
function lastAssistantText(path) {
  let lines
  try {
    lines = readFileSync(path, 'utf8').split('\n')
  } catch {
    return null
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line) continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    const msg = entry.message ?? entry
    if (msg?.role !== 'assistant') continue
    const content = msg.content
    const text = Array.isArray(content)
      ? content
          .filter((c) => c?.type === 'text' && typeof c.text === 'string')
          .map((c) => c.text)
          .join('\n')
          .trim()
      : typeof content === 'string'
        ? content.trim()
        : ''
    if (text) return { text, uuid: entry.uuid ?? null }
    // An assistant turn that was pure tool calls has no text worth mirroring —
    // the tools already reported themselves. Keep looking back.
  }
  return null
}

let db = null
try {
  // better-sqlite3 is a native module; resolve it from the app's node_modules,
  // whose location the app passes in. There is no node_modules next to a plugin.
  const require = createRequire(REQUIRE_FROM)
  const Database = require('better-sqlite3')
  db = new Database(DB)
  db.pragma('busy_timeout = 5000')
} catch {
  bail(db)
}

const alreadyMirrored = (uuid) => {
  if (!uuid) return false
  try {
    return !!db
      .prepare(
        `SELECT 1 FROM agent_messages
         WHERE session_key = ? AND direction = 'outbound'
           AND json_extract(meta, '$.uuid') = ? LIMIT 1`
      )
      .get(KEY, uuid)
  } catch {
    return false
  }
}

// Retry until a NOT-yet-mirrored assistant entry appears. A stale entry (the
// previous turn's reply) does not end the loop — the fresh one is still flushing.
let found = null
for (let i = 0; i < 8; i++) {
  const cand = lastAssistantText(hook.transcript_path)
  if (cand && !alreadyMirrored(cand.uuid)) {
    found = cand
    break
  }
  await new Promise((r) => setTimeout(r, 300))
}
if (!found) bail(db)

try {
  // Entries without a uuid (older transcript formats) fall back to a short
  // body-match window; it also catches the agent sending this exact text
  // through a tool moments ago.
  const dupe = db
    .prepare(
      `SELECT 1 FROM agent_messages
       WHERE session_key = ? AND direction = 'outbound' AND body = ? AND created_at > ?`
    )
    .get(KEY, found.text, Date.now() - 60_000)

  if (!dupe) {
    db.prepare(
      `INSERT INTO agent_messages (session_key, direction, kind, body, meta, created_at)
       VALUES (?, 'outbound', 'reply', ?, ?, ?)`
    ).run(KEY, found.text, JSON.stringify({ via: 'stop-hook', uuid: found.uuid }), Date.now())
    db.prepare('UPDATE agent_sessions SET last_seen_at = ? WHERE key = ?').run(Date.now(), KEY)
  }
  db.close()
} catch {
  /* the inbox is best-effort; never fail a turn over it */
}

process.exit(0)
