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
import { join } from 'path'
import { z } from 'zod'
import { getDb } from './store/db'
import { listNotes } from './store/notes'
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

/**
 * The assistant's long-term memory: one human-readable markdown file of dated,
 * one-line facts, injected whole into the session's system prompt.
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
 */

const SNAPSHOTS_KEPT = 10

export function memoryFile(): string {
  return join(app.getPath('userData'), 'assistant-memory.md')
}

function metaFile(): string {
  return join(app.getPath('userData'), 'assistant-memory.meta.json')
}

function snapshotDir(): string {
  return join(app.getPath('userData'), 'memory-snapshots')
}

function changelogFile(): string {
  return join(app.getPath('userData'), 'assistant-memory.log')
}

/**
 * The FULL file, untruncated. Consolidation must see everything: the Recent
 * section is the tail, so truncating here would hand the reconciler a file
 * missing the newest entries — which the write-back would then destroy.
 */
export function readMemory(): string {
  try {
    return readFileSync(memoryFile(), 'utf8')
  } catch {
    return ''
  }
}

/** Bounded view for system-prompt injection only. */
export function promptMemory(): string {
  return readMemory().slice(0, MEMORY_CAP)
}

export function writeMemory(text: string): void {
  const file = memoryFile()
  const tmp = `${file}.tmp`
  writeFileSync(tmp, text)
  renameSync(tmp, file)
}

/**
 * Guarantee every section header exists — not just the file. A user can erase
 * the textarea in Settings; a headerless file would make validateMemory reject
 * every consolidation forever (nothing to put sections back). Recent is kept
 * LAST so the bridge's blind append always lands inside it.
 */
export function ensureMemoryFile(): void {
  const current = readMemory()
  const missing = SECTION_NAMES.filter((s) => !current.includes(`## ${s}`))
  if (existsSync(memoryFile()) && missing.length === 0) return
  if (!current.trim()) {
    writeMemory(SECTION_NAMES.map((s) => `## ${s}\n`).join('\n') + '\n')
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
    [body.trimEnd(), added.trimEnd(), recentBlock.trimEnd()].filter(Boolean).join('\n\n') + '\n'
  )
}

/** Timestamped copy before any machine edit; humans get undo for free. */
function snapshot(): void {
  try {
    if (!existsSync(memoryFile())) return
    mkdirSync(snapshotDir(), { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    copyFileSync(memoryFile(), join(snapshotDir(), `memory-${stamp}.md`))
    const old = readdirSync(snapshotDir()).filter((f) => f.startsWith('memory-')).sort()
    for (const f of old.slice(0, Math.max(0, old.length - SNAPSHOTS_KEPT))) {
      rmSync(join(snapshotDir(), f), { force: true })
    }
  } catch (err) {
    console.error('[memory] snapshot failed:', err)
  }
}

interface MemoryMeta {
  lastRunAt: number
  /** High-water mark into agent_messages, so each run only sees what's new. */
  lastMessageId: number
}

function readMeta(): MemoryMeta {
  try {
    return JSON.parse(readFileSync(metaFile(), 'utf8')) as MemoryMeta
  } catch {
    return { lastRunAt: 0, lastMessageId: 0 }
  }
}

function writeMeta(meta: MemoryMeta): void {
  writeFileSync(metaFile(), JSON.stringify(meta))
}

/** Conversation since the last consolidation, oldest first, bounded. */
function newMaterial(sinceId: number): { text: string; maxId: number } {
  const rows = getDb()
    .prepare(
      `SELECT m.id, m.direction, m.kind, m.body FROM agent_messages m
       JOIN agent_sessions s ON s.key = m.session_key
       WHERE m.id > ? AND s.title = 'Assistant'
       ORDER BY m.id ASC LIMIT 200`
    )
    .all(sinceId) as Array<{ id: number; direction: string; kind: string; body: string }>
  if (rows.length === 0) return { text: '', maxId: sinceId }
  const text = rows
    .map((r) => `${r.direction === 'inbound' ? 'USER' : 'ASSISTANT'}: ${r.body.slice(0, 1500)}`)
    .join('\n---\n')
  return { text: text.slice(0, 24_000), maxId: rows[rows.length - 1].id }
}

// ── phase 1: extract candidate facts ────────────────────────────────────────

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

// ── phase 2: reconcile into the numbered file ───────────────────────────────

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

let running = false

export async function consolidateMemory(force = false): Promise<ConsolidateResult> {
  if (running) return { ok: true, changed: false }
  const meta = readMeta()
  const material = newMaterial(meta.lastMessageId)
  ensureMemoryFile()
  const current = readMemory()
  const pendingRecent = recentEntryCount(current)
  if (!material.text && pendingRecent === 0 && !force) return { ok: true, changed: false }

  running = true
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
      writeMeta({ lastRunAt: Date.now(), lastMessageId: material.maxId })
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
      writeMeta({ lastRunAt: Date.now(), lastMessageId: material.maxId })
      return { ok: true, changed: false }
    }

    let next = applyOps(current, ops as MemoryOp[])
    const problem = validateMemory(next, current, ops as MemoryOp[])
    if (problem) {
      console.error(`[memory] consolidation rejected: ${problem}`)
      return { ok: false, changed: false, error: `rejected: ${problem}` }
    }

    // The two LLM round-trips above take tens of seconds, and consolidation is
    // triggered by fresh conversation — exactly when the assistant is calling
    // `remember`. Carry over any lines the bridge appended since we read the
    // file, or the rename below would silently eat them.
    const fresh = readMemory()
    if (fresh !== current) {
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

    snapshot()
    writeMemory(next)
    writeMeta({ lastRunAt: Date.now(), lastMessageId: material.maxId })
    try {
      appendFileSync(changelogFile(), `${new Date().toISOString()} ${changelog}\n`)
    } catch {
      /* the changelog is best-effort */
    }
    console.log(`[memory] consolidated: ${changelog} (${ops.length} ops)`)
    return { ok: true, changed: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[memory] consolidation failed:', msg)
    return { ok: false, changed: false, error: msg }
  } finally {
    running = false
  }
}

/**
 * Draft an identity for Settings, from what the app already knows — the user
 * shouldn't have to face a blank textarea. Sources: current identity (a redraft
 * keeps their words), long-term memory, note titles, and which apps they copy
 * from. Marked guesses stay guesses; the user edits before it matters.
 */
export async function generateIdentity(currentIdentity: string): Promise<string> {
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
        '# Existing identity (rewrite/extend, keep their voice)',
        currentIdentity.trim() || '(none yet)',
        '',
        '# Long-term memory',
        promptMemory().trim() || '(empty)',
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
  setTimeout(() => void consolidateMemory(), 2 * 60_000)
  setInterval(() => void consolidateMemory(), 12 * 60 * 60_000)
  setInterval(() => {
    const text = readMemory()
    if (recentEntryCount(text) > 15 || text.length > MEMORY_CAP * 0.8) {
      void consolidateMemory()
    }
  }, 30 * 60_000)
}
