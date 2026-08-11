import { getSettings, updateSettings } from './settings'
import { parseDictionary, applyDictionary, type DictRule } from './dictionary'
import { vocabularyRules } from '@shared/vocabulary'
import { singleSubstitution, plausibleWritten, soundsAlike } from './correctionsMatch'
import type { DictationSuggestion } from '@shared/types'

/**
 * "Learn from corrections" — Phase 0 (deterministic, offline, no LLM).
 *
 * When a dictated transcript is pasted and the user then fixes a single
 * mis-transcribed word, propose a `heard => written` dictionary rule. Everything
 * here runs on-device: a word-level diff isolates the change, then a stack of
 * gates decides whether it's a plausible, reusable transcription fix. No audio, no
 * model, no network — see docs/DICTATION-LEARNING.md for the full design and the
 * later phases (LLM classifier, macOS AX field reads).
 *
 * Precision over recall throughout: a bad rule silently rewrites every future
 * transcript, while a missed suggestion costs nothing. So a candidate must survive
 * ALL of: a localized single substitution, a sound-alike test (or be casing-only),
 * a plausible written form, and — decisively — a rule SIMULATION: applying the
 * proposed rule to the original must reproduce exactly the user's edit and touch
 * nothing else. Anything short of that is dropped in silence.
 */

interface Pending {
  original: string
  itemId?: number
  destKey: string | null
  at: number
}

/** How recently the edit must follow the paste to count as a correction. */
const WINDOW_MS = 20_000
const PENDING_MAX = 3
const SUGGESTIONS_MAX = 25

const pending: Pending[] = []
const suggestions: DictationSuggestion[] = []

/** The most recent dictation clip, for the "correct last dictation" affordance. */
let lastDictationItemId: number | undefined

type Notify = (all: DictationSuggestion[], added?: DictationSuggestion) => void
let notify: Notify = () => {}

/** Wire the emit callback (broadcast + toast) from the main process. */
export function initCorrections(fn: Notify): void {
  notify = fn
}

function enabled(): boolean {
  return getSettings().dictation.learnCorrections === true
}

/** The last dictation clip id, so a menu action can reopen it for correction. */
export function lastDictationId(): number | undefined {
  return lastDictationItemId
}

/** Record a just-pasted transcript so a later edit can be matched against it. */
export function notePastedTranscript(p: {
  text: string
  itemId?: number
  destKey: string | null
}): void {
  // Tracked regardless of the toggle: the "correct last dictation" action is useful
  // even before someone turns learning on (and is how terminal/other-app dictations,
  // which we can't observe directly, get a correction path at all).
  if (p.itemId) lastDictationItemId = p.itemId
  if (!enabled() || !p.text.trim()) return
  pending.unshift({ original: p.text, itemId: p.itemId, destKey: p.destKey, at: Date.now() })
  if (pending.length > PENDING_MAX) pending.length = PENDING_MAX
}

/**
 * A foreign clipboard copy arrived (the user re-copied text). If it looks like an
 * edited version of a transcript we recently pasted into the same app, consider it.
 */
export function considerSnapshot(edited: string, destKey: string | null): void {
  if (!enabled() || !edited.trim()) return
  const now = Date.now()
  for (let i = pending.length - 1; i >= 0; i--) {
    if (now - pending[i].at > WINDOW_MS) pending.splice(i, 1)
  }
  for (const p of pending) {
    if (!destMatches(p.destKey, destKey)) continue
    const sub = singleSubstitution(p.original, edited)
    if (sub && tryMake(p.original, edited, sub, p.itemId, now - p.at)) return
  }
}

/**
 * A transcription clip was edited in our own scratchpad — a direct before/after
 * pair, no OS scraping, no recency needed (editing the clip is deliberate).
 */
export function considerScratchEdit(original: string, edited: string, itemId?: number): void {
  if (!enabled() || !original.trim() || !edited.trim()) return
  const sub = singleSubstitution(original, edited)
  if (sub) tryMake(original, edited, sub, itemId)
}

export function listSuggestions(): DictationSuggestion[] {
  return suggestions.slice()
}

/** Accept a suggestion: append the rule to the user's dictation dictionary. */
export function acceptSuggestion(key: string): void {
  const i = suggestions.findIndex((s) => s.key === key)
  if (i < 0) return
  const s = suggestions[i]
  const d = getSettings().dictation
  const line = `${s.from} => ${s.to}`
  const dictionary =
    d.dictionary && d.dictionary.trim() ? `${d.dictionary.replace(/\s+$/, '')}\n${line}` : line
  updateSettings({ dictation: { ...d, dictionary } })
  suggestions.splice(i, 1)
  notify(suggestions.slice())
}

/** Dismiss a suggestion: remember the pair so it never comes back. */
export function dismissSuggestion(key: string): void {
  const i = suggestions.findIndex((s) => s.key === key)
  const d = getSettings().dictation
  const dismissedSuggestions = Array.from(new Set([...(d.dismissedSuggestions ?? []), key]))
  updateSettings({ dictation: { ...d, dismissedSuggestions } })
  if (i >= 0) suggestions.splice(i, 1)
  notify(suggestions.slice())
}

// ── gates ────────────────────────────────────────────────────────────────────

function tryMake(
  original: string,
  edited: string,
  sub: { heard: string; written: string },
  itemId?: number,
  latencyMs?: number
): boolean {
  const { heard, written } = sub
  // Instrumentation: a candidate reached here means the diff found a localized
  // substitution, so logging which gate kills it (and never the text around it) tells
  // us — with real usage — whether the thresholds are right, without re-guessing.
  const drop = (gate: string): false => {
    console.log(`[corrections] candidate "${heard}"→"${written}" dropped at ${gate}`)
    return false
  }

  if (!plausibleWritten(written)) return drop('plausible-form')
  const casingOnly = heard.toLowerCase() === written.toLowerCase()
  if (!casingOnly && !soundsAlike(heard, written)) return drop('sound-alike')

  // Rule simulation — the decisive guard. The proposed rule must turn the original
  // into exactly the edit and alter nothing else; if it rewrites untouched text it's
  // a false positive by construction.
  const rule: DictRule = { from: heard, to: written }
  if (applyDictionary(original, [rule]) !== edited) return drop('rule-simulation')

  // Novelty: don't propose something the built-in vocabulary or an existing user
  // rule already covers. (If a rule for `heard` already fired, the transcript
  // wouldn't contain `heard` at all — this is belt-and-suspenders.)
  const style = getSettings().dictation.style === 'casual' ? 'casual' : 'as-spoken'
  const existing = [...vocabularyRules(style), ...parseDictionary(getSettings().dictation.dictionary)]
  if (existing.some((r) => r.from.toLowerCase() === heard.toLowerCase())) return drop('novelty')

  const key = `${heard}=>${written}`.toLowerCase()
  if ((getSettings().dictation.dismissedSuggestions ?? []).includes(key)) return drop('dismissed')
  if (suggestions.some((s) => s.key === key)) return drop('duplicate')

  const s: DictationSuggestion = {
    key,
    from: heard,
    to: written,
    reason: casingOnly ? 'capitalization fix' : 'sounds like what you dictated',
    itemId,
    at: Date.now()
  }
  suggestions.unshift(s)
  if (suggestions.length > SUGGESTIONS_MAX) suggestions.length = SUGGESTIONS_MAX
  const lat = latencyMs !== undefined ? `, ${Math.round(latencyMs / 1000)}s after paste` : ''
  console.log(`[corrections] suggest "${heard}" => "${written}" (${s.reason}${lat})`)
  notify(suggestions.slice(), s)
  return true
}

/** App identities match if either is unknown, equal, or one contains the other. */
function destMatches(a: string | null, b: string | null): boolean {
  if (!a || !b) return true
  const x = a.toLowerCase()
  const y = b.toLowerCase()
  return x === y || x.includes(y) || y.includes(x)
}
