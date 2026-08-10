/**
 * clipmd-bridge — the two-way channel between clipboard.md and one agent session.
 *
 * Modelled on Nullframe/mobot's track-bridge. One bridge process per session, started
 * by clipboard.md as that session's stdio MCP server:
 *
 *   session → us   the agent calls tools (post_progress / ask_question / post_done /
 *                  post_failure / save_note), which land in the app's inbox.
 *   us → session   we POST to the bridge's HTTP listener, which forwards the text as
 *                  a `notifications/claude/channel` notification. Claude surfaces
 *                  that to the session as a <channel> tag between turns — this is the
 *                  ONLY supported way to speak into a live interactive session; there
 *                  is no CLI verb for it.
 *
 * The `experimental: { 'claude/channel': {} }` capability is what enables the inbound
 * half. Without it the notification is ignored.
 *
 * Outbound messages are written straight to SQLite rather than posted to the app.
 * That keeps the app free of an HTTP server, and means a message sent while
 * clipboard.md is closed is still there when it opens — an agent's answer must never
 * depend on the GUI being up.
 *
 * Registered per session with:
 *   claude --mcp-config '{"mcpServers":{"clipmd":{"command":"node","args":[".../bridge.mjs"],"env":{...}}}}'
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { createServer } from 'http'
import { appendFileSync, readFileSync, writeFileSync, chmodSync, mkdirSync, statSync } from 'fs'
import { dirname } from 'path'
import { createRequire } from 'module'
import { randomBytes } from 'crypto'
import { ftsQuery } from '@shared/fts'

const SESSION_KEY = process.env.CLIPMD_SESSION_KEY ?? 'unknown'
const DB_PATH = process.env.CLIPMD_DB
/** The assistant's long-term memory file; the `remember` tool appends to it. */
const MEMORY_FILE = process.env.CLIPMD_MEMORY_FILE
/** Where to publish {port, pid, token} so the app can reach this bridge. */
const DISCOVERY_FILE = process.env.CLIPMD_BRIDGE_FILE
const TOKEN = process.env.CLIPMD_BRIDGE_TOKEN ?? randomBytes(16).toString('hex')
/** Fixed listen port (remote sandboxes: the app derives the public URL from it). */
const FIXED_PORT = Number(process.env.CLIPMD_BRIDGE_PORT ?? 0) || 0

/**
 * REMOTE mode: this bridge runs inside a sandbox with no app database on its
 * filesystem. Messages queue in memory instead, and the app drains them over
 * HTTP (GET /outbox) into its own SQLite. The Stop hook, which also can't reach
 * SQLite there, POSTs replies to /mirror on this loopback.
 *
 * Keyed off an EXPLICIT CLIPMD_REMOTE flag, never merely "no CLIPMD_DB": the
 * plugin is installed user-scope, so this same bridge also runs in the user's
 * own terminal claude sessions, which have neither var. There, silently queuing
 * into a void that nothing drains would tell the agent "delivered" and lose the
 * message — so a non-remote bridge with no DB stays honest and reports failure.
 */
const REMOTE = process.env.CLIPMD_REMOTE === '1'
interface QueuedMessage {
  seq: number
  direction: 'inbound' | 'outbound'
  kind: string
  body: string
  meta?: unknown
  createdAt: number
}
const queue: QueuedMessage[] = []
let queueSeq = 0
const QUEUE_CAP = 500
/** uuids already mirrored, so the hook's transcript retries can't duplicate. */
const mirroredUuids = new Set<string>()

function log(msg: string): void {
  // stdout is the MCP transport — anything not JSON-RPC there corrupts the stream.
  process.stderr.write(`[clipmd-bridge ${SESSION_KEY}] ${msg}\n`)
}

// ── inbox writes ────────────────────────────────────────────────────────────

// better-sqlite3 is loaded LAZILY: in a remote sandbox the package doesn't exist
// (and isn't needed), and a top-level import would kill the bridge on startup.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any = null
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getDb(): any {
  if (db) return db
  if (!DB_PATH) return null
  try {
    const require = createRequire(import.meta.url)
    const Database = require('better-sqlite3')
    db = new Database(DB_PATH)
    // The app is the primary writer; a busy timeout keeps a concurrent checkpoint
    // from turning into an immediate SQLITE_BUSY on our side.
    db.pragma('busy_timeout = 5000')
    return db
  } catch (err) {
    log(`could not open the database: ${String(err)}`)
    return null
  }
}

function record(direction: 'inbound' | 'outbound', kind: string, body: string, meta?: unknown): boolean {
  if (REMOTE) {
    // Inbound (the operator's own messages) is recorded APP-SIDE at send time,
    // never trusted from here: a queue the sandbox can write is a channel for
    // forging "you" messages into the operator's thread. Drop it.
    if (direction === 'inbound') return true
    queue.push({ seq: ++queueSeq, direction, kind, body, meta, createdAt: Date.now() })
    if (queue.length > QUEUE_CAP) queue.splice(0, queue.length - QUEUE_CAP)
    return true
  }
  const handle = getDb()
  if (!handle) return false
  try {
    handle
      .prepare(
        `INSERT INTO agent_messages (session_key, direction, kind, body, meta, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(SESSION_KEY, direction, kind, body, meta ? JSON.stringify(meta) : null, Date.now())
    handle
      .prepare('UPDATE agent_sessions SET last_seen_at = ? WHERE key = ?')
      .run(Date.now(), SESSION_KEY)
    return true
  } catch (err) {
    log(`inbox write failed: ${String(err)}`)
    return false
  }
}

// ── MCP server ──────────────────────────────────────────────────────────────

const mcp = new Server(
  { name: 'clipmd', version: '0.1.0' },
  {
    capabilities: { tools: {}, experimental: { 'claude/channel': {} } },
    instructions: [
      'You are running inside a clipboard.md agent session. The operator is not',
      'watching your terminal — they see only what you send through these tools, in',
      'an inbox. So report as you go rather than only at the end:',
      '',
      '  post_progress  a short status update worth surfacing',
      '  ask_question   you are blocked and need a decision. The answer arrives as a',
      '                 <channel> event; wait for it rather than guessing.',
      '  post_done      the work is finished, with a summary',
      '  post_failure   you cannot continue, with the reason',
      '  save_note      persist something durable (a plan, findings) into their notes',
      '',
      'You can also read their clipboard history: search_clipboard (keyword search),',
      'recent_clips (what they copied lately), get_clip (full content by id). When a',
      'message refers to "this" or something they copied, look there first. Use',
      'remember to record durable facts about the operator for future sessions.',
      '',
      'Messages FROM the operator arrive between turns as',
      '<channel source="clipboard.md" kind="..."> tags — clipboard contents they sent',
      'you, notes, or answers to your questions. Re-read your task when one arrives.'
    ].join('\n')
  }
)

const TOOLS = [
  {
    name: 'post_progress',
    description:
      'Report a status update to the operator’s inbox. Use for meaningful milestones, not every step.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'What you have done or are about to do.' } },
      required: ['text']
    }
  },
  {
    name: 'ask_question',
    description:
      'Ask the operator a question and STOP. The answer comes back as a <channel> event; do not guess and continue.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The question. Be specific and give options where possible.' }
      },
      required: ['text']
    }
  },
  {
    name: 'post_done',
    description: 'Report that the work is complete, with a summary of what changed.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Summary of the outcome.' } },
      required: ['text']
    }
  },
  {
    name: 'post_failure',
    description: 'Report that you cannot continue, and why.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'What blocked you.' } },
      required: ['text']
    }
  },
  {
    name: 'save_note',
    description:
      'Save durable output — a plan, findings, a summary — into the operator’s notes, where it is searchable later.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short title for the note.' },
        text: { type: 'string', description: 'Markdown body.' }
      },
      required: ['title', 'text']
    }
  },
  {
    name: 'search_clipboard',
    description:
      'Keyword-search the operator’s clipboard history (content, titles, tags, OCR text). Returns matches with ids; use get_clip for full content.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search terms.' },
        limit: { type: 'number', description: 'Max results (default 10, max 25).' }
      },
      required: ['query']
    }
  },
  {
    name: 'recent_clips',
    description:
      'The operator’s most recently copied items, newest first. Start here when they refer to "this" or something they just copied.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Max results (default 10, max 25).' } }
    }
  },
  {
    name: 'get_clip',
    description: 'Full content of one clipboard item by id.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'number', description: 'Clip id from search/recent results.' } },
      required: ['id']
    }
  },
  {
    name: 'remember',
    description:
      'Record a durable fact about the operator in your long-term memory. Save ONLY what is durable and likely to change future behavior: identity, projects, tools, preferences, decisions. Never short-lived states, trivia, pasted content, secrets, or sensitive attributes (health, politics, religion, precise location) unless explicitly asked. One concise third-person sentence per call. If asked to forget something, call this with "Forget: <what>".',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'The fact, one sentence, third person.' } },
      required: ['text']
    }
  }
] as const

// ── clipboard reads ─────────────────────────────────────────────────────────

interface ClipRow {
  id: number
  kind: string
  content: string
  auto_title: string | null
  ocr_text: string | null
  description: string | null
  created_at: number
}


/**
 * One clip as text an agent can use. Truncated: these land in a model's context,
 * and a 2MB clip would evict everything else the session was doing.
 */
function clipToText(r: ClipRow, full = false): string {
  const cap = full ? 32_768 : 800
  const head = `#${r.id} [${r.kind}] ${r.auto_title ?? ''} (${new Date(r.created_at).toISOString()})`
  let body: string
  if (r.kind === 'image') {
    body = [`image file: ${r.content}`, r.description, r.ocr_text && `text in image: ${r.ocr_text}`]
      .filter(Boolean)
      .join('\n')
  } else {
    body = r.content
  }
  const clipped = body.length > cap ? body.slice(0, cap) + `\n…[truncated, ${body.length} chars total]` : body
  return `${head}\n${clipped}`
}

// Secret-flagged clips are excluded at the SQL layer, unconditionally: this side of
// the bridge feeds a model, and credentials must never cross it.
const CLIP_COLS = 'id, kind, content, auto_title, ocr_text, description, created_at'

function toolError(text: string): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  return { content: [{ type: 'text', text }], isError: true }
}

function clipboardTool(
  name: string,
  args: { query?: string; limit?: number; id?: number }
): { content: Array<{ type: 'text'; text: string }>; isError?: boolean } | null {
  if (name !== 'search_clipboard' && name !== 'recent_clips' && name !== 'get_clip') return null
  if (REMOTE) {
    return toolError(
      'Clipboard history is not available in remote sessions yet (it lives on the operator’s machine). Ask the operator to paste what you need.'
    )
  }
  const handle = getDb()
  if (!handle) return toolError('Clipboard history is unavailable (no database).')
  const limit = Math.max(1, Math.min(25, Math.round(args.limit ?? 10)))
  try {
    if (name === 'get_clip') {
      if (typeof args.id !== 'number' || !Number.isFinite(args.id)) {
        return toolError('id must be a number (from search_clipboard or recent_clips results)')
      }
      const row = handle
        .prepare(`SELECT ${CLIP_COLS} FROM items WHERE id = ? AND secret = 0`)
        .get(args.id) as ClipRow | undefined
      return row
        ? { content: [{ type: 'text', text: clipToText(row, true) }] }
        : toolError(`No clip with id ${args.id}.`)
    }
    let rows: ClipRow[]
    if (name === 'search_clipboard') {
      const match = ftsQuery(args.query ?? '')
      if (!match) return toolError('query is required')
      rows = handle
        .prepare(
          `SELECT ${CLIP_COLS.replace(/(\w+)/g, 'items.$1')} FROM items_fts
           JOIN items ON items.id = items_fts.rowid
           WHERE items_fts MATCH ? AND items.secret = 0
           ORDER BY bm25(items_fts) LIMIT ?`
        )
        .all(match, limit) as ClipRow[]
    } else {
      rows = handle
        .prepare(
          `SELECT ${CLIP_COLS} FROM items WHERE secret = 0
           ORDER BY last_copied_at DESC LIMIT ?`
        )
        .all(limit) as ClipRow[]
    }
    if (rows.length === 0) return { content: [{ type: 'text', text: 'No matching clips.' }] }
    return { content: [{ type: 'text', text: rows.map((r) => clipToText(r)).join('\n\n') }] }
  } catch (err) {
    log(`clipboard tool ${name} failed: ${String(err)}`)
    return toolError('Clipboard lookup failed.')
  }
}

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS as unknown as [] }))

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name
  const args = (req.params.arguments ?? {}) as {
    text?: string
    title?: string
    query?: string
    limit?: number
    id?: number
  }
  const text = (args.text ?? '').trim()

  const clip = clipboardTool(name, args)
  if (clip) return clip

  if (name === 'remember') {
    if (!MEMORY_FILE) return toolError('Memory is unavailable in this session.')
    if (!text) return toolError('text is required')
    try {
      // Bounded: memory is injected into a system prompt, so it must stay small.
      // Past the cap, consolidation (app-side) has to make room first.
      const size = (() => {
        try {
          return statSync(MEMORY_FILE).size
        } catch {
          return 0
        }
      })()
      // Threshold = the app's MEMORY_CAP (16KB, memoryOps.ts) plus append headroom.
      // Larger would let the file outgrow what the system prompt injects — and the
      // injected view truncates the TAIL, which is exactly where appends land.
      if (size > 18_432) {
        return toolError('Memory file is full; it will be consolidated soon — try again later.')
      }
      // Appends land in the "Recent (unconsolidated)" tail section (kept LAST in
      // the file exactly so a blind append is correct); the app's consolidation
      // pass folds them into their proper sections later. Dated like every fact.
      // Lead with a newline when the file doesn't end in one — an externally
      // edited file ending mid-line otherwise welds the fact onto the last line.
      let lead = ''
      try {
        const tail = readFileSync(MEMORY_FILE, 'utf8')
        if (tail.length > 0 && !tail.endsWith('\n')) lead = '\n'
      } catch {
        /* file may not exist yet; append creates it */
      }
      const today = new Date().toISOString().slice(0, 10)
      appendFileSync(MEMORY_FILE, `${lead}- ${today}: ${text.replace(/\n+/g, ' ').slice(0, 500)}\n`)
      return { content: [{ type: 'text', text: 'Remembered.' }] }
    } catch (err) {
      log(`remember failed: ${String(err)}`)
      return toolError('Could not write to memory.')
    }
  }

  if (name === 'save_note') {
    const title = (args.title ?? '').trim() || 'Agent note'
    const ok = record('outbound', 'note', text, { title })
    return {
      content: [
        { type: 'text', text: ok ? `Saved note "${title}".` : 'Could not save the note (inbox unavailable).' }
      ],
      isError: !ok
    }
  }

  const kind = { post_progress: 'progress', ask_question: 'question', post_done: 'done', post_failure: 'failure' }[
    name
  ]
  if (!kind) {
    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true }
  }
  if (!text) {
    return { content: [{ type: 'text', text: 'text is required' }], isError: true }
  }

  const ok = record('outbound', kind, text)
  const ack =
    kind === 'question'
      ? 'Question delivered. Wait for the answer to arrive as a <channel> event before continuing.'
      : 'Delivered to the operator’s inbox.'
  return {
    content: [{ type: 'text', text: ok ? ack : 'Could not reach the inbox.' }],
    isError: !ok
  }
})

// ── inbound HTTP: clipboard.md → this session ───────────────────────────────

const http = createServer((req, res) => {
  // Loopback-only isn't enough on a shared machine — and in a sandbox this port
  // is PUBLIC behind the provider's proxy. The token is the whole gate.
  if (req.headers['x-token'] !== TOKEN) {
    log(`rejected ${req.method} ${req.url}: bad token`)
    res.writeHead(403).end('forbidden\n')
    return
  }

  // Remote mode: the app drains queued messages into its own SQLite. Cursor-
  // based, NOT destructive: /outbox?after=<seq> returns everything newer, and
  // messages are trimmed only once the app's cursor has advanced past them
  // (proving it durably stored them). A dropped or timed-out response therefore
  // loses nothing — the next request re-delivers from the same cursor.
  if (req.method === 'GET' && req.url?.startsWith('/outbox')) {
    const after = Number(new URL(req.url, 'http://x').searchParams.get('after') ?? 0) || 0
    // Everything at or below the acked cursor is safe to forget.
    while (queue.length > 0 && queue[0].seq <= after) queue.shift()
    const pending = queue.filter((m) => m.seq > after)
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(pending))
    return
  }

  if (req.method !== 'POST') {
    res.writeHead(405).end('method not allowed\n')
    return
  }
  let body = ''
  req.on('data', (c) => {
    body += c
  })
  req.on('end', () => {
    // Remote mode: the Stop hook can't reach SQLite, so it mirrors replies here.
    if (req.url === '/mirror') {
      try {
        const m = JSON.parse(body) as { text?: string; uuid?: string }
        if (!m.text) throw new Error('no text')
        if (m.uuid && mirroredUuids.has(m.uuid)) {
          res.writeHead(200).end('dup\n')
          return
        }
        if (m.uuid) mirroredUuids.add(m.uuid)
        record('outbound', 'reply', m.text, { via: 'stop-hook', uuid: m.uuid })
        res.writeHead(200).end('ok\n')
      } catch (e) {
        res.writeHead(400).end(`bad mirror payload: ${String(e)}\n`)
      }
      return
    }

    const kind = String(req.headers['x-kind'] ?? 'message')
    log(`inbound ${body.length}b kind=${kind}`)
    void mcp
      .notification({
        method: 'notifications/claude/channel',
        params: { content: body, meta: { source: 'clipboard.md', kind } }
      })
      .catch((e) => log(`channel notification failed: ${String(e)}`))
    record('inbound', kind, body)
    res.writeHead(200).end('ok\n')
  })
})

// Only a REMOTE bridge binds 0.0.0.0 (the sandbox provider's proxy reaches it
// from outside loopback). A local bridge — which has full clipboard DB access —
// stays loopback-only even if it somehow inherited CLIPMD_BRIDGE_PORT, so it can
// never be reached from the LAN.
http.listen(REMOTE ? FIXED_PORT : 0, REMOTE ? '0.0.0.0' : '127.0.0.1', () => {
  const addr = http.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  log(`inbound listener on 127.0.0.1:${port}`)
  if (!DISCOVERY_FILE) return
  try {
    mkdirSync(dirname(DISCOVERY_FILE), { recursive: true })
    writeFileSync(DISCOVERY_FILE, JSON.stringify({ port, pid: process.pid, token: TOKEN }))
    // The token is a capability to inject instructions into an agent running with
    // bypassed permissions. Nobody else on the machine gets to read it.
    chmodSync(DISCOVERY_FILE, 0o600)
  } catch (err) {
    log(`could not write the discovery file: ${String(err)}`)
  }
})

const transport = new StdioServerTransport()
await mcp.connect(transport)
log('connected over stdio')
