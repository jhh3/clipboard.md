import { app } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getDb } from './store/db'

const execFileP = promisify(execFile)

/**
 * Session lifecycle: adopt orphans, put idle sessions to sleep, tear down dead ones.
 *
 * Adapted from Nullframe/mobot's sweep, whose resilience rules are the point of this
 * file and are followed literally:
 *
 *   - every subprocess call has a timeout and never throws on non-zero exit;
 *   - every step is individually wrapped, so one failure cannot block the other steps
 *     for that session, or the whole pass for other sessions;
 *   - the pass is idempotent — running it twice on the same state is a no-op;
 *   - single-flight, so two passes can never race each other;
 *   - nothing is destroyed without being archived first.
 *
 * Two phases, mirroring mobot:
 *
 *   Dormancy   an idle session's tmux/claude process is killed to reclaim memory, but
 *              its row and Claude session id are KEPT, so it can be revived with
 *              `claude --resume`. `last_seen_at` is deliberately NOT bumped, so the
 *              teardown clock keeps running from the last real activity.
 *   Teardown   an exited session past the grace period, or a dormant one past its
 *              hard TTL, is archived and its bridge artefacts removed.
 */

const PREFIX = 'clipmd-'
/** Idle this long with nothing said in either direction → sleep. */
const DORMANT_IDLE_MS = 2 * 60 * 60 * 1000
/** Leave a dead session alone this long so the user can still read its thread. */
const TEARDOWN_GRACE_MS = 24 * 60 * 60 * 1000
/** A dormant session never revived within this is gone for good. */
const HARD_TTL_MS = 7 * 24 * 60 * 60 * 1000
const TIMEOUT_QUICK = 15_000

function agentsDir(): string {
  return join(app.getPath('userData'), 'agents')
}

function archiveDir(): string {
  return join(app.getPath('userData'), 'agents', 'archive')
}

/** Structured so a sweep can be read after the fact: what, to whom, and why. */
function report(action: string, key: string, outcome: string, why?: string): void {
  console.log(`[agents] ${action} ${key} → ${outcome}${why ? ` (${why})` : ''}`)
}

/** Never throws, always bounded. A sweep must not die on one bad command. */
async function run(cmd: string, args: string[], timeout = TIMEOUT_QUICK): Promise<string | null> {
  try {
    const { stdout } = await execFileP(cmd, args, { timeout })
    return stdout
  } catch {
    return null
  }
}

async function tmuxSessions(): Promise<Set<string>> {
  const out = await run('tmux', ['list-sessions', '-F', '#{session_name}'], 5000)
  const set = new Set<string>()
  for (const line of (out ?? '').split('\n')) if (line.trim()) set.add(line.trim())
  return set
}

function isAlive(pid: number | null): boolean {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Learn Claude's own session id for our sessions.
 *
 * Without it a dormant session cannot be revived — `claude --resume` needs the id,
 * and ours is only a tmux name. `claude agents --json` reports every live session
 * with its cwd, so we match on the cwd of sessions we know are ours.
 */
async function learnSessionIds(): Promise<void> {
  const out = await run('claude', ['agents', '--json'], 10_000)
  if (!out) return
  let live: Array<{ cwd?: string; sessionId?: string; pid?: number }> = []
  try {
    live = JSON.parse(out) as typeof live
  } catch {
    return
  }
  const db = getDb()
  const rows = db
    .prepare("SELECT key, cwd, session_id FROM agent_sessions WHERE status IN ('running','starting')")
    .all() as Array<{ key: string; cwd: string; session_id: string | null }>
  for (const row of rows) {
    if (row.session_id) continue
    const match = live.find((s) => s.cwd === row.cwd && s.sessionId)
    if (!match?.sessionId) continue
    try {
      db.prepare('UPDATE agent_sessions SET session_id = ? WHERE key = ?').run(match.sessionId, row.key)
      report('learn-session-id', row.key, 'ok')
    } catch {
      /* another pass may have set it; harmless */
    }
  }
}

/**
 * Adopt or bury sessions whose process state disagrees with our record.
 *
 * The app can be killed while sessions keep running, and sessions die while the app
 * is closed. Either way the row is wrong afterwards, and a stale "running" row is
 * worse than none — the user sends a clip into it and nothing happens, silently.
 *
 * We only ever touch tmux sessions carrying our prefix. Somebody else's tmux session
 * is not ours to reap.
 */
async function reconcileState(live: Set<string>): Promise<void> {
  const db = getDb()
  const rows = db
    .prepare("SELECT key, pid, status FROM agent_sessions WHERE status IN ('running','starting')")
    .all() as Array<{ key: string; pid: number | null; status: string }>

  for (const row of rows) {
    try {
      if (live.has(row.key) || isAlive(row.pid)) continue
      rmSync(join(agentsDir(), `${row.key}.json`), { force: true })
      db.prepare("UPDATE agent_sessions SET status = 'exited', ended_at = ? WHERE key = ?").run(
        Date.now(),
        row.key
      )
      report('bury', row.key, 'exited', 'process is gone')
    } catch (err) {
      report('bury', row.key, 'failed', String(err))
    }
  }

  // The reverse: a tmux session of ours that the DB thinks is finished. It really is
  // running, so re-adopt it rather than leaving a live agent nobody can see.
  for (const name of live) {
    if (!name.startsWith(PREFIX)) continue
    try {
      const row = db.prepare('SELECT status FROM agent_sessions WHERE key = ?').get(name) as
        | { status: string }
        | undefined
      if (!row) {
        report('adopt', name, 'skipped', 'no record — not ours to claim')
        continue
      }
      if (row.status === 'running') continue
      db.prepare("UPDATE agent_sessions SET status = 'running', ended_at = NULL WHERE key = ?").run(name)
      report('adopt', name, 'running', `was ${row.status}`)
    } catch (err) {
      report('adopt', name, 'failed', String(err))
    }
  }
}

/** Phase 1: sleep idle sessions, keeping everything needed to revive them. */
async function sweepDormant(live: Set<string>): Promise<void> {
  const db = getDb()
  const cutoff = Date.now() - DORMANT_IDLE_MS
  const rows = db
    .prepare("SELECT key, session_id FROM agent_sessions WHERE status = 'running' AND last_seen_at < ?")
    .all(cutoff) as Array<{ key: string; session_id: string | null }>

  for (const row of rows) {
    try {
      if (live.has(row.key)) await run('tmux', ['kill-session', '-t', row.key])
      rmSync(join(agentsDir(), `${row.key}.json`), { force: true })
      // last_seen_at is NOT bumped: the hard-TTL clock must keep running from the
      // last real activity, not from the moment we put it to sleep.
      db.prepare("UPDATE agent_sessions SET status = 'dormant' WHERE key = ?").run(row.key)
      report('dormant', row.key, 'slept', row.session_id ? 'resumable' : 'no session id — not resumable')
    } catch (err) {
      report('dormant', row.key, 'failed', String(err))
    }
  }
}

/** Phase 2: archive and clean up sessions that are never coming back. */
async function sweepTeardown(): Promise<void> {
  const db = getDb()
  const now = Date.now()
  const rows = db
    .prepare(
      `SELECT key, status, last_seen_at FROM agent_sessions
       WHERE (status = 'exited' AND last_seen_at < ?)
          OR (status = 'dormant' AND last_seen_at < ?)`
    )
    .all(now - TEARDOWN_GRACE_MS, now - HARD_TTL_MS) as Array<{
    key: string
    status: string
    last_seen_at: number
  }>

  for (const row of rows) {
    try {
      archive(row.key)
    } catch (err) {
      // Archiving failing must not stop the cleanup — but we do not delete the
      // messages in that case, so nothing is lost silently.
      report('archive', row.key, 'failed', String(err))
      continue
    }
    try {
      rmSync(join(agentsDir(), `${row.key}.json`), { force: true })
      rmSync(join(agentsDir(), `${row.key}.mcp.json`), { force: true })
      db.prepare('DELETE FROM agent_messages WHERE session_key = ?').run(row.key)
      db.prepare('DELETE FROM agent_sessions WHERE key = ?').run(row.key)
      report('teardown', row.key, 'removed', `was ${row.status}`)
    } catch (err) {
      report('teardown', row.key, 'failed', String(err))
    }
  }
}

/** Write the session and its whole thread to disk before anything is deleted. */
function archive(key: string): void {
  const db = getDb()
  const session = db.prepare('SELECT * FROM agent_sessions WHERE key = ?').get(key)
  const messages = db
    .prepare('SELECT * FROM agent_messages WHERE session_key = ? ORDER BY created_at')
    .all(key)
  mkdirSync(archiveDir(), { recursive: true })
  writeFileSync(
    join(archiveDir(), `${key}.json`),
    JSON.stringify({ session, messages, archivedAt: Date.now() }, null, 2)
  )
}

/**
 * One full pass. Single-flight: a second call while one is running returns
 * immediately rather than racing it.
 */
let sweeping = false

export async function sweep(): Promise<void> {
  if (sweeping) return
  sweeping = true
  try {
    const live = await tmuxSessions()
    // Each phase is independent — one throwing must not skip the others.
    for (const [name, phase] of [
      ['reconcile', () => reconcileState(live)],
      ['learn-ids', () => learnSessionIds()],
      ['dormant', () => sweepDormant(live)],
      ['teardown', () => sweepTeardown()]
    ] as Array<[string, () => Promise<void>]>) {
      try {
        await phase()
      } catch (err) {
        console.error(`[agents] sweep phase ${name} failed:`, err)
      }
    }
  } finally {
    sweeping = false
  }
}

/** True when a dormant session still has what it needs to be resumed. */
export function resumable(key: string): string | null {
  const row = getDb()
    .prepare("SELECT session_id FROM agent_sessions WHERE key = ? AND status = 'dormant'")
    .get(key) as { session_id: string | null } | undefined
  return row?.session_id ?? null
}

export function archivePathFor(key: string): string | null {
  const p = join(archiveDir(), `${key}.json`)
  return existsSync(p) ? p : null
}
