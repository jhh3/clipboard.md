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
 * Deliberately dependency-free and written straight to SQLite via the app's own
 * better-sqlite3 — a hook runs in claude's process tree, not ours, so it cannot rely
 * on anything but node and paths we hand it through the environment.
 *
 * Never blocks the session: any failure exits 0 quietly. A broken mirror must not
 * stop an agent from working.
 */
import { readFileSync } from 'fs'
import { createRequire } from 'module'

const KEY = process.env.CLIPMD_SESSION_KEY
const DB = process.env.CLIPMD_DB
const REQUIRE_FROM = process.env.CLIPMD_REQUIRE_FROM

function bail() {
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

/**
 * Pull the last assistant text out of the transcript.
 *
 * The transcript is JSONL, one message per line. We take only the final assistant
 * message: mirroring every intermediate step would flood the inbox with the tool
 * chatter the user is reading the inbox to avoid.
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
    if (text) return text
    // An assistant turn that was pure tool calls has no text worth mirroring —
    // the tools already reported themselves. Keep looking back.
  }
  return null
}

const text = hook.transcript_path ? lastAssistantText(hook.transcript_path) : null
if (!text) bail()

try {
  // better-sqlite3 is a native module; resolve it from the app's node_modules,
  // whose location the app passes in. There is no node_modules next to a plugin.
  const require = createRequire(REQUIRE_FROM)
  const Database = require('better-sqlite3')
  const db = new Database(DB)
  db.pragma('busy_timeout = 5000')

  // Don't double-report: if the agent already sent this exact text through a tool
  // in the last minute, the hook has nothing to add.
  const dupe = db
    .prepare(
      `SELECT 1 FROM agent_messages
       WHERE session_key = ? AND direction = 'outbound' AND body = ? AND created_at > ?`
    )
    .get(KEY, text, Date.now() - 60_000)

  if (!dupe) {
    db.prepare(
      `INSERT INTO agent_messages (session_key, direction, kind, body, meta, created_at)
       VALUES (?, 'outbound', 'reply', ?, ?, ?)`
    ).run(KEY, text, JSON.stringify({ via: 'stop-hook' }), Date.now())
    db.prepare('UPDATE agent_sessions SET last_seen_at = ? WHERE key = ?').run(Date.now(), KEY)
  }
  db.close()
} catch {
  /* the inbox is best-effort; never fail a turn over it */
}

process.exit(0)
