import { app } from 'electron'
import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  readdirSync,
  rmSync,
  appendFileSync,
  copyFileSync
} from 'fs'
import { basename, join } from 'path'
import { z } from 'zod'
import { getDb } from './store/db'
import { listNotes } from './store/notes'
import { getSettings } from './settings'
import { completeJson } from './modelport'
import {
  MEMORY_CAP,
  RECENT,
  SECTION_NAMES,
  applyOps,
  recentEntryCount,
  validateMemory,
  type MemoryOp
} from './memoryOps'
import type { AgentDef } from '@shared/types'

/**
 * Long-term memory, per agent: one human-readable markdown file of dated,
 * one-line facts, injected whole into the agent's system prompt.
 *
 * The design follows where mem0, Letta, Zep, ChatGPT memory and Anthropic's
 * memory tool all independently converged (researched 2026-08-08):
 *
 *  - the ARTIFACT is a small block of dated third-person one-liners under labeled
 *    sections, injected at session start — at our 16KB cap, inject-all strictly
 *    beats any retrieval machinery (OpenAI's bet; Anthropic's at the index tier)
 *  - the WRITER is separate from the talker (Letta's sleep-time agents): the
 *    session appends explicit facts via the bridge's `remember` tool into a
 *    "Recent (unconsolidated)" tail section, and a background pass on the cheap
 *    enrichment lane folds them upward
 *  - consolidation RECONCILES, never blind-rewrites (mem0's ADD/UPDATE/DELETE):
 *    phase 1 extracts candidate facts from new conversation, phase 2 emits
 *    per-line ops against the numbered current file, applied mechanically — a
 *    bad model output can corrupt one line, not the file
 *  - guard-rails are mechanical: size cap, required sections, bounded deletes,
 *    a timestamped snapshot before every change, and a changelog line per pass
 *    so nothing mutates invisibly (the core documented failure of ChatGPT memory)
 *
 * MULTI-AGENT: each agent definition chooses memory 'own' (a private file),
 * 'shared' (the primary's file), or 'off'. The primary keeps the original
 * assistant-memory.md; other 'own' agents get memory-agent-<name>.md. All
 * sidecars (meta, snapshots, changelog) derive from the file path, so the
 * primary's legacy sidecars keep working.
 */

const SNAPSHOTS_KEPT = 10

// ── agent resolution ────────────────────────────────────────────────────────

function defs(): AgentDef[] {
  return getSettings().agents
}

export function primaryAgent(): AgentDef | undefined {
  return defs()[0]
}

export function agentByName(name?: string): AgentDef | undefined {
  return name ? defs().find((a) => a.name === name) : primaryAgent()
}

/**
 * The singleton-session title for an agent. The primary keeps the historical
 * 'Assistant' title so pre-multi-agent sessions (and their message history)
 * stay attached to it.
 */
export function sessionTitleFor(def: AgentDef): string {
  return def.name === primaryAgent()?.name ? 'Assistant' : `@${def.name}`
}

/** Effective memory mode: primary defaults to 'own', everyone else to 'off'. */
function memoryMode(def: AgentDef): 'own' | 'shared' | 'off' {
  return def.memory ?? (def.name === primaryAgent()?.name ? 'own' : 'off')
}

/**
 * The memory file an agent reads/writes, or null when it has none. 'shared'
 * resolves to the primary's file — cross-agent knowledge on purpose.
 */
export function memoryFile(agentName?: string): string | null {
  const def = agentByName(agentName)
  if (!def) return null
  const primary = primaryAgent()
  const mode = memoryMode(def)
  if (mode === 'off') return null
  if (mode === 'shared' && primary && primary.name !== def.name) {
    return memoryFile(primary.name)
  }
  return def.name === primary?.name
    ? join(app.getPath('userData'), 'assistant-memory.md')
    : join(app.getPath('userData'), `memory-agent-${def.name}.md`)
}

/** Agents that OWN a memory file (consolidation runs once per owned file). */
function memoryOwners(): AgentDef[] {
  const primary = primaryAgent()
  return defs().filter(
    (d) => memoryMode(d) === 'own' || (memoryMode(d) === 'shared' && d.name === primary?.name)
  )
}

function metaFile(file: string): string {
  return file.replace(/\.md$/, '') + '.meta.json'
}

function changelogFile(file: string): string {
  return file.replace(/\.md$/, '') + '.log'
}

function snapshotDir(): string {
  return join(app.getPath('userData'), 'memory-snapshots')
}

// ── file primitives ─────────────────────────────────────────────────────────

/**
 * The FULL file, untruncated. Consolidation must see everything: the Recent
 * section is the tail, so truncating here would hand the reconciler a file
 * missing the newest entries — which the write-back would then destroy.
 */
export function readMemory(agentName?: string): string {
  const file = memoryFile(agentName)
  if (!file) return ''
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

/** Bounded view for system-prompt injection only. */
export function promptMemory(agentName?: string): string {
  return readMemory(agentName).slice(0, MEMORY_CAP)
}

export function writeMemory(text: string, agentName?: string): void {
  const file = memoryFile(agentName)
  if (!file) return
  const tmp = `${file}.tmp`
  writeFileSync(tmp, text)
  renameSync(tmp, file)
}

/**
 * A user edit from Settings. Snapshots first (this path replaces the whole file,
 * and it had no undo), and guarantees a trailing newline — the bridge's
 * `remember` blind-appends, and a file ending mid-line silently welded the next
 * remembered fact onto the last line, corrupting both.
 */
export function saveMemoryEdit(text: string, agentName?: string): void {
  const file = memoryFile(agentName)
  if (!file) return
  snapshot(file)
  writeMemory(text.trim() ? text.replace(/\n*$/, '\n') : '', agentName)
  ensureMemoryFile(agentName)
}

/**
 * Guarantee every section header exists — not just the file. A user can erase
 * the textarea in Settings; a headerless file would make validateMemory reject
 * every consolidation forever (nothing to put sections back). Recent is kept
 * LAST so the bridge's blind append always lands inside it.
 */
export function ensureMemoryFile(agentName?: string): void {
  const file = memoryFile(agentName)
  if (!file) return
  const current = readMemory(agentName)
  const missing = SECTION_NAMES.filter((s) => !current.includes(`## ${s}`))
  if (existsSync(file) && missing.length === 0) return
  if (!current.trim()) {
    writeMemory(SECTION_NAMES.map((s) => `## ${s}\n`).join('\n') + '\n', agentName)
    return
  }
  const recentHeader = `## ${RECENT}`
  const idx = current.indexOf(recentHeader)
  const body = idx >= 0 ? current.slice(0, idx) : current
  const recentBlock = idx >= 0 ? current.slice(idx) : `${recentHeader}\n`
  const added = missing
    .filter((s) => s !== RECENT)
    .map((s) => `## ${s}\n`)
    .join('\n')
  writeMemory(
    [body.trimEnd(), added.trimEnd(), recentBlock.trimEnd()].filter(Boolean).join('\n\n') + '\n',
    agentName
  )
}

/** Timestamped copy before any machine edit; humans get undo for free. */
function snapshot(file: string): void {
  try {
    if (!existsSync(file)) return
    mkdirSync(snapshotDir(), { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const prefix = basename(file).replace(/\.md$/, '')
    copyFileSync(file, join(snapshotDir(), `${prefix}-${stamp}.md`))
    const old = readdirSync(snapshotDir())
      .filter((f) => f.startsWith(`${prefix}-`))
      .sort()
    for (const f of old.slice(0, Math.max(0, old.length - SNAPSHOTS_KEPT))) {
      rmSync(join(snapshotDir(), f), { force: true })
    }
  } catch (err) {
    console.error('[memory] snapshot failed:', err)
  }
}

// ── consolidation ───────────────────────────────────────────────────────────

interface MemoryMeta {
  lastRunAt: number
  /** High-water mark into agent_messages, so each run only sees what's new. */
  lastMessageId: number
}

function readMeta(file: string): MemoryMeta {
  try {
    return JSON.parse(readFileSync(metaFile(file), 'utf8')) as MemoryMeta
  } catch {
    return { lastRunAt: 0, lastMessageId: 0 }
  }
}

function writeMeta(file: string, meta: MemoryMeta): void {
  writeFileSync(metaFile(file), JSON.stringify(meta))
}

/** Conversation since the last consolidation, oldest first, bounded. `titles`
 *  scopes to the sessions whose conversation feeds this memory file. */
function newMaterial(sinceId: number, titles: string[]): { text: string; maxId: number } {
  const placeholders = titles.map(() => '?').join(', ')
  const rows = getDb()
    .prepare(
      `SELECT m.id, m.direction, m.kind, m.body FROM agent_messages m
       JOIN agent_sessions s ON s.key = m.session_key
       WHERE m.id > ? AND s.title IN (${placeholders})
       ORDER BY m.id ASC LIMIT 200`
    )
    .all(sinceId, ...titles) as Array<{ id: number; direction: string; kind: string; body: string }>
  if (rows.length === 0) return { text: '', maxId: sinceId }
  const text = rows
    .map((r) => `${r.direction === 'inbound' ? 'USER' : 'ASSISTANT'}: ${r.body.slice(0, 1500)}`)
    .join('\n---\n')
  return { text: text.slice(0, 24_000), maxId: rows[rows.length - 1].id }
}

/** Session titles whose conversations feed an agent's memory file — the agent's
 *  own, plus every agent sharing that file. */
function feedingTitles(owner: AgentDef): string[] {
  const file = memoryFile(owner.name)
  return defs()
    .filter((d) => memoryFile(d.name) === file)
    .map((d) => sessionTitleFor(d))
}

const FactsSchema = z.object({ facts: z.array(z.string()) })

const EXTRACT_SYSTEM = [
  'You extract durable personal facts from a conversation between a user and',
  'their assistant, for the assistant’s long-term memory. Return',
  '{"facts": ["...", ...]} — each fact one short third-person present-tense',
  'sentence about the USER (identity, projects, tools, preferences, decisions,',
  'ongoing threads) or a lesson the assistant should retain.',
  'Save ONLY what is durable and likely to change future behavior. Never:',
  'short-lived states, trivia, message content the user merely pasted, secrets,',
  'credentials, or sensitive attributes (health, politics, religion, precise',
  'location) unless the user explicitly asked to remember them.',
  'If the user asked to forget something, express it as a fact: "Asked to',
  'forget: ...". Return {"facts": []} when nothing qualifies.'
].join('\n')

const OpSchema = z.object({
  op: z.enum(['add', 'update', 'delete']),
  /** 1-based line number in the numbered file; required for update/delete. */
  line: z.number().optional(),
  /** Target section for add; defaults to Recent when unknown. */
  section: z.string().optional(),
  text: z.string().optional()
})
const OpsSchema = z.object({ ops: z.array(OpSchema), changelog: z.string() })

const RECONCILE_SYSTEM = [
  'You maintain a personal assistant’s memory file. You receive the current',
  'file with numbered lines, plus new candidate facts. Emit',
  '{"ops": [...], "changelog": "..."} where each op is',
  '  {"op":"add","section":"<section name>","text":"- YYYY-MM-DD: fact."}',
  '  {"op":"update","line":N,"text":"- YYYY-MM-DD: revised fact."}',
  '  {"op":"delete","line":N}',
  'Rules:',
  '- every fact line is "- YYYY-MM-DD: <third-person, present tense>." with',
  '  today’s date on anything you add or revise',
  '- a fact that CHANGED gets an update (supersede with the new date), not a',
  '  delete+add pair; delete only true removals (duplicates, trivia, things the',
  '  user asked to forget)',
  '- fold every entry out of "Recent (unconsolidated)" into its proper section:',
  '  delete the Recent line and add (or merge into) the right section',
  '- merge near-duplicates into one line; prefer the more specific wording',
  '- leave correct lines completely untouched — emit NO op for them',
  '- never edit section header lines',
  '- if the file is near its size budget, tighten: merge and drop the least',
  '  valuable lines (as explicit deletes)',
  'When nothing needs to change, return {"ops": [], "changelog": "no changes"}.'
].join('\n')

export interface ConsolidateResult {
  ok: boolean
  changed: boolean
  error?: string
}

const running = new Set<string>()

export async function consolidateMemory(force = false, agentName?: string): Promise<ConsolidateResult> {
  const def = agentByName(agentName)
  const file = def ? memoryFile(def.name) : null
  if (!def || !file) return { ok: true, changed: false }
  if (running.has(file)) return { ok: true, changed: false }
  const meta = readMeta(file)
  const material = newMaterial(meta.lastMessageId, feedingTitles(def))
  ensureMemoryFile(def.name)
  const current = readMemory(def.name)
  const pendingRecent = recentEntryCount(current)
  if (!material.text && pendingRecent === 0 && !force) return { ok: true, changed: false }

  running.add(file)
  try {
    // Phase 1: candidates from new conversation (skipped when there is none —
    // a run can exist purely to fold the Recent tail upward).
    let facts: string[] = []
    if (material.text) {
      const notes = listNotes({})
        .slice(0, 15)
        .map((n) => `- ${n.title || 'Untitled'}`)
        .join('\n')
      const res = await completeJson(
        'enrichment',
        {
          system: EXTRACT_SYSTEM,
          prompt: `# Conversation\n${material.text}\n\n# Recent note titles (context only)\n${notes}`,
          maxTokens: 800
        },
        FactsSchema
      )
      facts = res.facts.slice(0, 25)
    }
    if (facts.length === 0 && pendingRecent === 0 && !force) {
      writeMeta(file, { lastRunAt: Date.now(), lastMessageId: material.maxId })
      return { ok: true, changed: false }
    }

    // Phase 2: per-line reconciliation against the numbered file.
    const numbered = current
      .split('\n')
      .map((l, i) => `${i + 1}| ${l}`)
      .join('\n')
    const today = new Date().toISOString().slice(0, 10)
    const { ops, changelog } = await completeJson(
      'enrichment',
      {
        system: RECONCILE_SYSTEM,
        prompt: [
          `Today: ${today}`,
          `Size budget: ${MEMORY_CAP} chars (current ${current.length})`,
          '',
          '# Current memory (numbered)',
          numbered,
          '',
          '# Candidate facts',
          facts.length ? facts.map((f) => `- ${f}`).join('\n') : '(none — just fold Recent upward)'
        ].join('\n'),
        maxTokens: 1500
      },
      OpsSchema
    )

    if (ops.length === 0) {
      writeMeta(file, { lastRunAt: Date.now(), lastMessageId: material.maxId })
      return { ok: true, changed: false }
    }

    let next = applyOps(current, ops as MemoryOp[])
    const problem = validateMemory(next, current, ops as MemoryOp[])
    if (problem) {
      console.error(`[memory] consolidation rejected (${basename(file)}): ${problem}`)
      return { ok: false, changed: false, error: `rejected: ${problem}` }
    }

    // The two LLM round-trips above take tens of seconds, and consolidation is
    // triggered by fresh conversation — exactly when the agent is calling
    // `remember`. Pure appends (the only thing the bridge does) are carried over;
    // ANY other concurrent change means a human edited the file, and their edit
    // outranks ours — abort without writing rather than resurrect what they
    // deleted. The next scheduled pass re-reads and reconciles from scratch.
    const fresh = readMemory(def.name)
    if (fresh !== current) {
      if (!fresh.startsWith(current)) {
        console.log('[memory] file was edited mid-consolidation; keeping the edit, not our pass')
        return { ok: true, changed: false }
      }
      const known = new Set(current.split('\n'))
      const appended = fresh.split('\n').filter((l) => l.startsWith('- ') && !known.has(l))
      if (appended.length > 0) {
        next = applyOps(
          next,
          appended.map((text) => ({ op: 'add' as const, section: RECENT, text }))
        )
        console.log(`[memory] carried ${appended.length} line(s) appended mid-consolidation`)
      }
    }

    snapshot(file)
    writeMemory(next, def.name)
    writeMeta(file, { lastRunAt: Date.now(), lastMessageId: material.maxId })
    try {
      appendFileSync(changelogFile(file), `${new Date().toISOString()} ${changelog}\n`)
    } catch {
      /* the changelog is best-effort */
    }
    console.log(`[memory] consolidated ${basename(file)}: ${changelog} (${ops.length} ops)`)
    return { ok: true, changed: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[memory] consolidation failed:', msg)
    return { ok: false, changed: false, error: msg }
  } finally {
    running.delete(file)
  }
}

/** Consolidate every owned memory file (scheduled path). */
async function consolidateAll(): Promise<void> {
  for (const def of memoryOwners()) {
    await consolidateMemory(false, def.name)
  }
}

/**
 * Identity drafting for Settings, from what the app already knows — the user
 * shouldn't have to face a blank textarea. Sources: current identity (a redraft
 * keeps their words), the agent's memory, note titles, and which apps they copy
 * from. Marked guesses stay guesses; the user edits before it matters.
 */
export async function generateIdentity(currentIdentity: string, agentName?: string): Promise<string> {
  const apps = getDb()
    .prepare(
      `SELECT source_app, COUNT(*) c FROM items
       WHERE source_app IS NOT NULL AND secret = 0
       GROUP BY source_app ORDER BY c DESC LIMIT 8`
    )
    .all() as Array<{ source_app: string; c: number }>
  const notes = listNotes({})
    .slice(0, 12)
    .map((n) => `- ${n.title || 'Untitled'}`)
    .join('\n')
  const def = agentByName(agentName)
  const draft = await completeJson(
    'enrichment',
    {
      system: [
        'Draft the identity section of a personal assistant’s system prompt, written',
        'in the USER’s first person ("I am...", "Help me by..."). Base it ONLY on the',
        'material provided; mark uncertain inferences with "(?)". Cover: who they are',
        'and what they work on; how the assistant should communicate (length, tone);',
        'standing context worth knowing. Terse markdown, max 25 lines, no preamble.',
        'Return {"identity": "..."}.'
      ].join('\n'),
      prompt: [
        `# Agent this identity is for`,
        def ? `${def.name}${def.description ? ` — ${def.description}` : ''}` : '(primary)',
        '',
        '# Existing identity (rewrite/extend, keep their voice)',
        currentIdentity.trim() || '(none yet)',
        '',
        '# Long-term memory',
        promptMemory(agentName).trim() || '(empty)',
        '',
        '# Recent note titles',
        notes || '(none)',
        '',
        '# Apps they copy from most',
        apps.map((a) => `- ${a.source_app} (${a.c})`).join('\n') || '(unknown)'
      ].join('\n'),
      maxTokens: 800
    },
    z.object({ identity: z.string() })
  )
  return draft.identity.trim()
}

/**
 * Schedule: shortly after launch (overnight material), every 12h, and an
 * adaptive check — a bloated Recent tail or a near-full file consolidates ahead
 * of schedule (Generative-Agents-style trigger, without importance bookkeeping).
 */
export function startMemorySchedule(): void {
  setTimeout(() => void consolidateAll(), 2 * 60_000)
  setInterval(() => void consolidateAll(), 12 * 60 * 60_000)
  setInterval(() => {
    for (const def of memoryOwners()) {
      const text = readMemory(def.name)
      if (recentEntryCount(text) > 15 || text.length > MEMORY_CAP * 0.8) {
        void consolidateMemory(false, def.name)
      }
    }
  }, 30 * 60_000)
}
