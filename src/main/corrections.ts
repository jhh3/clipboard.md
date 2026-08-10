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

type Notify = (all: DictationSuggestion[], added?: DictationSuggestion) => void
let notify: Notify = () => {}

/** Wire the emit callback (broadcast + toast) from the main process. */
export function initCorrections(fn: Notify): void {
  notify = fn
}

function enabled(): boolean {
  return getSettings().dictation.learnCorrections === true
}

/** Record a just-pasted transcript so a later edit can be matched against it. */
export function notePastedTranscript(p: {
  text: string
  itemId?: number
  destKey: string | null
}): void {
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
    if (sub && tryMake(p.original, edited, sub, p.itemId)) return
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
  itemId?: number
): boolean {
  const { heard, written } = sub
  if (!plausibleWritten(written)) return false
  const casingOnly = heard.toLowerCase() === written.toLowerCase()
  if (!casingOnly && !soundsAlike(heard, written)) return false

  // Rule simulation — the decisive guard. The proposed rule must turn the original
  // into exactly the edit and alter nothing else; if it rewrites untouched text it's
  // a false positive by construction.
  const rule: DictRule = { from: heard, to: written }
  if (applyDictionary(original, [rule]) !== edited) return false

  // Novelty: don't propose something the built-in vocabulary or an existing user
  // rule already covers. (If a rule for `heard` already fired, the transcript
  // wouldn't contain `heard` at all — this is belt-and-suspenders.)
  const style = getSettings().dictation.style === 'casual' ? 'casual' : 'as-spoken'
  const existing = [...vocabularyRules(style), ...parseDictionary(getSettings().dictation.dictionary)]
  if (existing.some((r) => r.from.toLowerCase() === heard.toLowerCase())) return false

  const key = `${heard}=>${written}`.toLowerCase()
  if ((getSettings().dictation.dismissedSuggestions ?? []).includes(key)) return false
  if (suggestions.some((s) => s.key === key)) return false

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
  console.log(`[corrections] suggest "${heard}" => "${written}" (${s.reason})`)
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
