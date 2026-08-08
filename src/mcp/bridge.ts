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
import { writeFileSync, chmodSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import { randomBytes } from 'crypto'
import Database from 'better-sqlite3'

const SESSION_KEY = process.env.CLIPMD_SESSION_KEY ?? 'unknown'
const DB_PATH = process.env.CLIPMD_DB
/** Where to publish {port, pid, token} so the app can reach this bridge. */
const DISCOVERY_FILE = process.env.CLIPMD_BRIDGE_FILE
const TOKEN = process.env.CLIPMD_BRIDGE_TOKEN ?? randomBytes(16).toString('hex')

function log(msg: string): void {
  // stdout is the MCP transport — anything not JSON-RPC there corrupts the stream.
  process.stderr.write(`[clipmd-bridge ${SESSION_KEY}] ${msg}\n`)
}

// ── inbox writes ────────────────────────────────────────────────────────────

let db: Database.Database | null = null
function getDb(): Database.Database | null {
  if (db) return db
  if (!DB_PATH) {
    log('CLIPMD_DB unset — outbound messages cannot be recorded')
    return null
  }
  try {
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
  }
] as const

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS as unknown as [] }))

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name
  const args = (req.params.arguments ?? {}) as { text?: string; title?: string }
  const text = (args.text ?? '').trim()

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
  if (req.method !== 'POST') {
    res.writeHead(405).end('method not allowed\n')
    return
  }
  // Loopback-only isn't enough on a shared machine: any local process could speak
  // into the agent otherwise. The token file is chmod 600.
  if (req.headers['x-token'] !== TOKEN) {
    log('rejected inbound POST: bad token')
    res.writeHead(403).end('forbidden\n')
    return
  }
  let body = ''
  req.on('data', (c) => {
    body += c
  })
  req.on('end', () => {
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

http.listen(0, '127.0.0.1', () => {
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
