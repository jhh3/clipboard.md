import { app } from 'electron'
import { spawn, execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { randomBytes } from 'crypto'
import { getDb } from './store/db'
import { getSettings } from './settings'
import { resumable } from './agentLifecycle'
import { CHANNEL_REF, hookEnv } from './agentPlugin'
import type { AgentProfile, AgentSession, AgentMessage } from '@shared/types'

const execFileP = promisify(execFile)

/**
 * Agent sessions: spawn, address, and listen to Claude Code sessions.
 *
 * We only ever list sessions WE started. That is not a limitation we settled for —
 * it is the whole design. A session is addressable because we launched it with a
 * bridge MCP attached (src/mcp/bridge.ts); `claude agents --json` can see every
 * session on the machine, but there is no way to speak into one that has no bridge.
 * Showing them would be showing things you cannot use.
 *
 * Shape follows Nullframe/mobot: a tmux session per agent so the TUI is attachable
 * from a real terminal, an optional git worktree so parallel agents don't fight over
 * a checkout, and a bridge for two-way messaging.
 */

function bridgeDir(): string {
  return join(app.getPath('userData'), 'agents')
}

function discoveryFile(key: string): string {
  return join(bridgeDir(), `${key}.json`)
}

function dbPath(): string {
  return join(app.getPath('userData'), 'data', 'clipboard.db')
}

// ── profiles ────────────────────────────────────────────────────────────────

export function profiles(): AgentProfile[] {
  return getSettings().agentProfiles
}

export function profile(name: string): AgentProfile | undefined {
  return profiles().find((p) => p.name === name)
}

// ── spawning ────────────────────────────────────────────────────────────────

/**
 * `copus` and friends are shell aliases, which do not survive spawn — resolve to the
 * real binary and flags instead. Bypass mode is deliberate and per-profile: these are
 * sessions the user explicitly launched to do work unattended.
 */
function claudeArgs(p: AgentProfile, key: string, prompt?: string): string[] {
  // --dangerously-load-development-channels is the load-bearing flag. Registering the
  // bridge with --mcp-config instead gives working TOOLS and a channel that is
  // silently ignored — verified against a live session, which took no notice of a
  // notifications/claude/channel either idle or mid-turn. The channel only exists
  // when the server arrives as a plugin-provided development channel.
  const args = ['--dangerously-load-development-channels', CHANNEL_REF]
  if (p.bypassPermissions !== false) args.push('--dangerously-skip-permissions')
  // No --model: profiles inherit whatever the CLI default is, deliberately, so they
  // don't drift as defaults change.
  for (const dir of p.addDirs ?? []) args.push('--add-dir', dir)
  if (p.appendSystemPrompt) args.push('--append-system-prompt', p.appendSystemPrompt)
  if (prompt) args.push(prompt)
  return args
}

/**
 * Per-session values for the bridge.
 *
 * These cannot live in the plugin's .mcp.json — one plugin serves every session — so
 * they go into the tmux session's environment and the MCP server inherits them
 * through claude. Same approach as mobot.
 */
function sessionEnv(key: string): Record<string, string> {
  return {
    CLIPMD_SESSION_KEY: key,
    CLIPMD_DB: dbPath(),
    CLIPMD_BRIDGE_FILE: discoveryFile(key),
    CLIPMD_BRIDGE_TOKEN: randomBytes(16).toString('hex'),
    // ELECTRON_RUN_AS_NODE so the Stop hook can invoke our binary as plain node.
    ELECTRON_RUN_AS_NODE: '1',
    ...hookEnv()
  }
}

async function tmuxAvailable(): Promise<boolean> {
  try {
    await execFileP('tmux', ['-V'], { timeout: 2000 })
    return true
  } catch {
    return false
  }
}

/**
 * Startup menus claude can stop on, and the keys that dismiss each.
 *
 * Loading a custom MCP channel makes claude ask whether it trusts the folder /
 * development channels, and the session WEDGES on that menu — the bridge connects
 * over stdio, so everything looks healthy from our side, while the session never
 * reaches chat and nothing we send is ever read. Taken from Nullframe/mobot, which
 * hit exactly this.
 */
const DEV_CHANNEL_MENU = [
  'Loading development channels',
  'I am using this for local development',
  'Is this a project you created',
  'Yes, I trust this folder'
]
const RESUME_SUMMARY_MENU = ['Resume from summary', 'Resume full session as-is']
/**
 * Catch-all for a menu we don't know about. claude default-highlights the safe
 * choice, so a bare Enter accepts it — this is what stops a NEW menu from wedging
 * every spawn until someone notices.
 */
const GENERIC_PROMPT = [
  'Enter to confirm',
  '❯ 1.',
  'Do you want to proceed',
  '(use arrow keys',
  'Press enter to continue'
]
/** claude is in the live chat UI once its input footer is drawn. */
// Taken from a real session's footer, not guessed. The previous values
// ('? for shortcuts', 'Bypassing Permissions') never matched anything, so the wait
// always ran the full timeout and then logged a false "never reached chat-ready"
// about a session that was fine.
const CHAT_READY = [
  'bypass permissions on',
  'shift+tab to cycle',
  'for shortcuts',
  '⏵⏵',
  'Try "'
]

/**
 * Wait for claude to reach its chat UI, dismissing startup menus on the way.
 *
 * Deliberately NOT a blind keystroke on a timer. Two reasons, both learned the hard
 * way in mobot: a menu can take well over 5s to draw under load, so a timed guess
 * races it; and a stray key sent to a menu that is still up can CANCEL it and exit
 * claude. So we only ever send keys when a prompt we recognise is actually on
 * screen, and we wait for a positive ready signal rather than assuming.
 */
async function waitForChatReady(target: string, timeoutMs = 180_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  let lastNudge = 0
  while (Date.now() < deadline) {
    const screen = await run('tmux', ['capture-pane', '-p', '-t', target], 5000)
    if (screen === null) return true // pane is gone; let the caller surface the real error
    if (CHAT_READY.some((m) => screen.includes(m))) return true

    let keys: string[] | null = null
    if (DEV_CHANNEL_MENU.some((m) => screen.includes(m))) keys = ['1', 'Enter']
    else if (RESUME_SUMMARY_MENU.some((m) => screen.includes(m))) keys = ['Enter']
    else if (GENERIC_PROMPT.some((m) => screen.includes(m))) keys = ['Enter']

    // Rate-limit: a menu takes a moment to redraw, and hammering keys at it is how
    // you end up several menus deep or cancelling out of claude entirely.
    if (keys && Date.now() - lastNudge > 2000) {
      await run('tmux', ['send-keys', '-t', target, ...keys], 5000)
      lastNudge = Date.now()
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  console.error(`[agents] ${target} never reached chat-ready; it may be stuck on a prompt`)
  return false
}

/** Bounded, non-throwing. A spawn must not die because one tmux call failed. */
async function run(cmd: string, args: string[], timeout = 15_000): Promise<string | null> {
  try {
    const { stdout } = await execFileP(cmd, args, { timeout })
    return stdout
  } catch {
    return null
  }
}

export interface LaunchOptions {
  profile: string
  /** Opening prompt — a clip, a note, or free text. */
  prompt?: string
  title?: string
}

/**
 * Start a session. Returns its key.
 *
 * tmux when available, because it makes the session attachable from the user's own
 * terminal (`tmux attach -t <key>`) rather than trapping the TUI inside a window we
 * would have to build. Falls back to a detached child so the feature still works
 * without tmux — the bridge, which is what actually matters, is identical either way.
 */
export async function launchSession(opts: LaunchOptions): Promise<string> {
  const p = profile(opts.profile)
  if (!p) throw new Error(`unknown agent profile: ${opts.profile}`)

  const key = `clipmd-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`
  const cwd = p.cwd || app.getPath('home')
  if (!existsSync(cwd)) throw new Error(`profile "${p.name}" points at a missing directory: ${cwd}`)

  const db = getDb()
  db.prepare(
    `INSERT INTO agent_sessions (key, profile, cwd, title, status, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, 'starting', ?, ?)`
  ).run(key, p.name, cwd, opts.title ?? null, Date.now(), Date.now())

  const args = claudeArgs(p, key, opts.prompt)
  const useTmux = p.tmux !== false && (await tmuxAvailable())

  if (useTmux) {
    // -d so launching never steals the user's terminal; they attach when they want.
    const env = sessionEnv(key)
    const envFlags = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`])
    await execFileP('tmux', ['new-session', '-d', '-s', key, '-c', cwd, ...envFlags, 'claude', ...args])
  } else {
    const child = spawn('claude', args, {
      cwd,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, ...sessionEnv(key) }
    })
    child.unref()
    db.prepare('UPDATE agent_sessions SET pid = ? WHERE key = ?').run(child.pid ?? null, key)
  }

  db.prepare("UPDATE agent_sessions SET status = 'running' WHERE key = ?").run(key)
  // Dismiss the trust/dev-channel menu the custom MCP channel triggers. Without
  // this the session sits on that menu forever: the bridge is connected, so it
  // looks alive, but nothing we send is ever read.
  if (useTmux) void waitForChatReady(key)
  return key
}

// ── addressing a running session ────────────────────────────────────────────

interface Discovery {
  port: number
  pid: number
  token: string
}

function discovery(key: string): Discovery | null {
  const file = discoveryFile(key)
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Discovery
  } catch {
    return null
  }
}

/**
 * Speak into a running session.
 *
 * The bridge turns this into a `notifications/claude/channel` notification, which
 * Claude surfaces to the session between turns. This is the only supported route
 * into a live interactive session — there is no CLI verb for it.
 */
export async function sendToSession(key: string, text: string, kind = 'message'): Promise<boolean> {
  let d = discovery(key)
  if (!d) {
    // A dormant session was put to sleep to reclaim memory but kept everything it
    // needs; waking it is the right answer to "send this there", not an error.
    if (await reviveSession(key)) {
      // The bridge needs a moment to bind its port and publish the discovery file.
      for (let i = 0; i < 20 && !d; i++) {
        await new Promise((r) => setTimeout(r, 250))
        d = discovery(key)
      }
    }
  }
  if (!d) {
    console.error(`[agents] no bridge for ${key} — it may still be starting, or have exited`)
    return false
  }
  try {
    const res = await fetch(`http://127.0.0.1:${d.port}/`, {
      method: 'POST',
      headers: { 'x-token': d.token, 'x-kind': kind, 'content-type': 'text/plain' },
      body: text,
      signal: AbortSignal.timeout(4000)
    })
    return res.ok
  } catch (err) {
    console.error(`[agents] could not reach the bridge for ${key}:`, err)
    return false
  }
}

/**
 * Wake a dormant session with `claude --resume`.
 *
 * Dormancy kills the process but keeps the row and Claude's session id precisely so
 * this is possible — the conversation continues rather than starting over.
 */
export async function reviveSession(key: string): Promise<boolean> {
  const sessionId = resumable(key)
  if (!sessionId) return false
  const db = getDb()
  const row = db.prepare('SELECT profile, cwd FROM agent_sessions WHERE key = ?').get(key) as
    | { profile: string; cwd: string }
    | undefined
  const p = row ? profile(row.profile) : undefined
  if (!row || !p) return false

  try {
    const args = ['--resume', sessionId, ...claudeArgs(p, key)]
    if (p.tmux !== false && (await tmuxAvailable())) {
      const envFlags = Object.entries(sessionEnv(key)).flatMap(([k, v]) => ['-e', `${k}=${v}`])
      await execFileP('tmux', ['new-session', '-d', '-s', key, '-c', row.cwd, ...envFlags, 'claude', ...args])
    } else {
      const child = spawn('claude', args, {
        cwd: row.cwd,
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, ...sessionEnv(key) }
      })
      child.unref()
      db.prepare('UPDATE agent_sessions SET pid = ? WHERE key = ?').run(child.pid ?? null, key)
    }
    db.prepare("UPDATE agent_sessions SET status = 'running', last_seen_at = ? WHERE key = ?").run(
      Date.now(),
      key
    )
    // --resume adds its own "resume from summary" menu on top of the trust one.
    if (p.tmux !== false) void waitForChatReady(key)
    console.log(`[agents] revived ${key} from session ${sessionId}`)
    return true
  } catch (err) {
    console.error(`[agents] could not revive ${key}:`, err)
    return false
  }
}

// ── state ───────────────────────────────────────────────────────────────────

function rowToSession(r: Record<string, unknown>): AgentSession {
  return {
    key: r.key as string,
    profile: r.profile as string,
    cwd: r.cwd as string,
    title: (r.title as string) ?? null,
    status: r.status as AgentSession['status'],
    createdAt: r.created_at as number,
    lastSeenAt: r.last_seen_at as number,
    unread: (r.unread as number) ?? 0,
    /** True once the bridge has published its port — i.e. it can be spoken to. */
    reachable: existsSync(discoveryFile(r.key as string))
  }
}

export function listSessions(includeEnded = false): AgentSession[] {
  const rows = getDb()
    .prepare(
      `SELECT s.*, (
         SELECT COUNT(*) FROM agent_messages m
         WHERE m.session_key = s.key AND m.direction = 'outbound' AND m.read_at IS NULL
       ) AS unread
       FROM agent_sessions s
       ${includeEnded ? '' : "WHERE s.status != 'exited'"}
       ORDER BY s.last_seen_at DESC`
    )
    .all() as Record<string, unknown>[]
  return rows.map(rowToSession)
}

export function messages(key: string, limit = 200): AgentMessage[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM agent_messages WHERE session_key = ?
       ORDER BY created_at DESC LIMIT ?`
    )
    .all(key, limit) as Record<string, unknown>[]
  return rows.reverse().map((r) => ({
    id: r.id as number,
    sessionKey: r.session_key as string,
    direction: r.direction as AgentMessage['direction'],
    kind: r.kind as string,
    body: r.body as string,
    meta: r.meta ? (JSON.parse(r.meta as string) as Record<string, unknown>) : undefined,
    createdAt: r.created_at as number,
    readAt: (r.read_at as number) ?? null
  }))
}

/** Everything the agents have said that the user hasn't seen — the inbox proper. */
export function inbox(limit = 100): AgentMessage[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM agent_messages WHERE direction = 'outbound' AND read_at IS NULL
       ORDER BY created_at DESC LIMIT ?`
    )
    .all(limit) as Record<string, unknown>[]
  return rows.map((r) => ({
    id: r.id as number,
    sessionKey: r.session_key as string,
    direction: 'outbound',
    kind: r.kind as string,
    body: r.body as string,
    meta: r.meta ? (JSON.parse(r.meta as string) as Record<string, unknown>) : undefined,
    createdAt: r.created_at as number,
    readAt: null
  }))
}

export function markRead(sessionKey?: string): void {
  const db = getDb()
  if (sessionKey) {
    db.prepare('UPDATE agent_messages SET read_at = ? WHERE session_key = ? AND read_at IS NULL').run(
      Date.now(),
      sessionKey
    )
  } else {
    db.prepare('UPDATE agent_messages SET read_at = ? WHERE read_at IS NULL').run(Date.now())
  }
}

export function unreadCount(): number {
  const r = getDb()
    .prepare("SELECT COUNT(*) c FROM agent_messages WHERE direction = 'outbound' AND read_at IS NULL")
    .get() as { c: number }
  return r.c
}

export async function endSession(key: string): Promise<void> {
  const db = getDb()
  try {
    await execFileP('tmux', ['kill-session', '-t', key], { timeout: 3000 })
  } catch {
    /* not a tmux session, or already gone */
  }
  const row = db.prepare('SELECT pid FROM agent_sessions WHERE key = ?').get(key) as
    | { pid: number | null }
    | undefined
  if (row?.pid) {
    try {
      process.kill(row.pid)
    } catch {
      /* already exited */
    }
  }
  rmSync(discoveryFile(key), { force: true })
  rmSync(join(bridgeDir(), `${key}.mcp.json`), { force: true })
  db.prepare("UPDATE agent_sessions SET status = 'exited', ended_at = ? WHERE key = ?").run(Date.now(), key)
}

