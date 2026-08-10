# Learn from Corrections — Design Doc

Auto-suggesting dictation dictionary rules from high-confidence post-paste corrections.

## 1. Summary

When clipboard.md dictates and pastes a transcript, it knows exactly what text it inserted (the transcription clip stored at `src/main/ipc.ts:349-355`). "Learn from corrections" watches for the user immediately fixing a single mis-transcribed word in that pasted text, isolates the `heard → written` change with a word-level diff, and — only after a stack of deterministic on-device gates pass — asks a cheap LLM whether the edit is a genuine transcription error worth remembering. If so, it proposes appending a rule to the existing `settings.dictation.dictionary` string (`src/shared/types.ts:306`), which `parseDictionary`/`applyDictionary` (`src/main/dictionary.ts:30-74`) already pick up on the next transcript with no new plumbing. The feature is opt-in, biased hard toward precision, and — per the codebase's own accessibility constraints (`src/main/focusedWindow.ts:14-20`) — has full reach only on macOS.

## 2. How it works

**Capture what we pasted.** Dictation begins in `beginDictation()` (`src/main/index.ts:300-308`), which records `dictateStartedAt` and calls `noteDictationTarget()` (`src/main/focusedWindow.ts:92`). The transcript is produced by `correctTranscript()` (`src/main/ipc.ts:328-334`, `src/main/dictionary.ts:206`), stored as a clip tagged `contentClass:'transcription'` (`src/main/ipc.ts:349-356`), and injected by `paste.pasteRaw(text,'text')` (`src/main/ipc.ts:386-388`). The transcribe handler already returns this clip `id` to the renderer (`src/main/ipc.ts:388`), so we know precisely which text landed where and when.

**Register a pending dictation.** Immediately after the paste succeeds in the `scratch:transcribe` handler (`src/main/ipc.ts:386-391`) — the natural hook point, where we still hold `text`, the clip `id`, the destination from `getDictationTarget()` / `macFrontmost()` (`src/main/mac/helper.ts:140`), and `dictateStartedAt` — push a `PendingDictation { original, destKey, pastedAt, itemId }` onto a small ring buffer (last ~3).

**Observe what the text became.** Two sources, whichever fires first inside the window:
- *Clipboard re-copy (cross-platform, free).* The `CaptureService` already fires on clipboard changes and distinguishes self-writes via `markSelfWrite` from foreign copies (`src/main/capture/index.ts:95-191,214`). A *foreign* copy whose text is a near-superset of `original` is the edited snapshot. Costs nothing until the user actually re-copies.
- *In-app scratchpad edit (cross-platform, free).* Opening a dictation clip in the scratchpad and editing it flows through `scratch:save` with `derivedFrom` set (`src/main/ipc.ts:413-429`), giving a persisted before/after pair with no OS scraping.
- *AX field read (macOS only, new helper capability).* See §3.

**Diff → gate → classify → suggest.** Word-level Myers/LCS diff isolates the single smallest substitution span (`heard`, `written`, ±40 chars context). Deterministic gates G1–G6 (§4) run entirely on-device; only survivors reach the fast-LLM classifier, routed through the same `transforms` lane the existing enhance pass uses (`src/main/ipc.ts:339`). Its JSON verdict is re-validated locally and *simulated* — `applyDictionary(original, [{from:heard,to:written}])` must reproduce exactly this edit and touch nothing else — before a suggestion surfaces. Acceptance appends a `heard => written` line to `dictation.dictionary` via the settings IPC (`src/main/ipc.ts:266-267`); `DictionaryField` (`src/renderer/.../Settings.tsx:184-208,1556-1566`) then renders it with zero extra wiring.

## 3. Feasibility on macOS vs Linux

**macOS — feasible, with one new helper subcommand.** The Swift helper already reads AX attributes: `macSelectedText()` (`src/main/mac/helper.ts:127`) shells the `selected-text` subcommand (`clipmd-helper.swift:131,157`) and the AX plumbing (`axCopyAttribute`, focused-element resolution) exists. Two real limits:
- It returns `kAXSelectedText` (the *selection*), not `kAXValue` (the whole field). After a paste the caret is collapsed, so an immediate read returns nothing. Reading "what the text became" requires a **new subcommand** doing `axCopyAttribute(element, kAXValueAttribute)`.
- It is a one-shot pull — there is no `AXObserver`/notification wiring today. So you either poll the new value-read a few seconds after paste, or add a `kAXValueChangedNotification` observer in the helper (does not exist yet).

Both build on infrastructure already gated behind the Accessibility grant the app manages (`EXIT_UNTRUSTED`, `src/main/mac/helper.ts:20,104`).

**Linux — cross-app field reading is NOT feasible.** `src/main/focusedWindow.ts:14-20` establishes it directly: GNOME refuses introspection and only Xwayland `_NET_ACTIVE_WINDOW` is readable; there is no AX/AT-SPI equivalent wired, and `noteDictationTarget` only ever captures `WM_CLASS` (`focusedWindow.ts:35`), an app identity, never text. **Drop AT-SPI** — the detection-design input's suggestion of an AT-SPI read on Linux is speculative and contradicted by the codebase. On Linux the feature is limited to the two cross-platform observation sources that don't scrape a foreign field: clipboard re-copy (`capture/index.ts`) and in-app scratchpad edits (`ipc.ts:413-429`).

**Not feasible anywhere via the clipboard watcher alone:** it only sees the clipboard, not edits to already-pasted text, and it deliberately swallows our own writes (`markSelfWrite`, `capture/index.ts:214`) — which is *why* the just-pasted transcript isn't re-captured. It becomes a signal only when the user re-copies the corrected text.

## 4. Reliability plan

**Everything below the classifier is deterministic and offline**, consistent with the pipeline's stated philosophy (`src/main/dictionary.ts:4-20,76-90`, `src/shared/vocabulary.ts:10-20`). Gates run cheapest-first; any failure drops the candidate silently.

| Gate | Rule | Default |
|---|---|---|
| **G1 Recency** | edit observed within N seconds of paste | **20 s** |
| **G2 Same destination** | `destKey` at observation == `destKey` at paste (`macFrontmost` / `focusedWmClass`) | exact match |
| **G3 Localized, not rewrite** | changed chars ≤ 25% of `original`, ≤ 2 disjoint changed spans, ≥ 80% token overlap | as stated |
| **G4 Sound-alike** | per span: normalized Levenshtein ≤ 0.5 **OR** Metaphone/Double-Metaphone/Soundex match | as stated |
| **G5 Plausible written form** | 1–3 tokens, ≤ 40 chars, matches `/^[\p{L}\p{N}.\-'/&+ ]+$/`, not stopword-only, no digit churn | as stated |
| **G6 Novelty / dedup** | `heard` not already covered — reuse `parseDictionary`+`applyDictionary` (if the rule *would already have fired*, nothing to learn) and check `vocabularyRules()` (`vocabulary.ts:96`); not in the dismissed-set | as stated |

**Casing-only shortcut:** if `heard.toLowerCase() === written.toLowerCase()` (e.g. "github"→"GitHub"), skip the LLM and go straight to a *medium-band suggestion* (never silent) — high value, low risk, but plausibly stylistic.

**Fast-LLM classifier (high-precision design).** Routed through the existing `transforms` lane (same lane as the enhance pass, `ipc.ts:339`), `json:true`, cheap model. It receives only `ORIGINAL` / `CORRECTED` / short `CONTEXT` — never audio, never the full transcript, never the whole field. System prompt instructs it to default **NO**, answer YES only when the two forms sound alike AND the correction is a reusable word/name/brand AND it's a like-for-like substitution, and to reject rephrasing, self-typos, autocorrect artifacts, and one-off identifiers (names, emails, order numbers). Output: `{is_correction, confidence, heard, written, reason}`.

**Post-LLM guards (never trust the model blind):**
- Accept only `is_correction===true` AND `confidence ≥ τ`. Two bands: **τ_auto = 0.9**, **τ_suggest = 0.7**; below 0.7 drop.
- Re-validate the model's `heard`/`written` against G4 (phonetic/distance) and G5 (shape) — catches the model broadening a rule beyond its evidence.
- **Rule simulation:** `applyDictionary(original,[{from:heard,to:written}])` must reproduce exactly this edit and alter nothing else. A rule that rewrites untouched text is a false positive by construction.
- Malformed/empty/schema-invalid JSON → treat as NO.

**False-positive guards:** rephrasing caught by G3+G4; autocorrect over-correction downgraded to suggest when `written` isn't a brand/internal-capital token (reuse `keepsCapital` from `dictionary.ts`); PII/one-off identifiers (email, phone, @handle, URL, order/card number, file path) rejected by a local pre-filter *before* the LLM sees them, so sensitive text never leaves the machine; plausible **person-name** forms downgraded to suggest-only, never silent; homographs (`heard` is a common English word, `written` its homophone) require τ_auto **and** a repeat-count of >1 across distinct dictations before any auto-add. A bad rule silently corrupts every future transcript while a missed suggestion costs nothing — so precision wins everywhere.

## 5. Settings & UX

New fields under the existing `dictation` block (`src/shared/types.ts:292`, defaults at `:516`):

```ts
dictation: {
  learnCorrections?: boolean      // parent toggle — default OFF
  autoAddCorrections?: boolean    // silent high band — default OFF (shown only when parent on)
  watchAxCorrections?: boolean    // macOS AX field read — default OFF (shown only when parent on)
  dismissedSuggestions?: string[] // G6 rejected-set, "heard=>written"
}
```

- **`Learn from my corrections` — default OFF.** It observes post-paste behavior and can send text to an LLM, both of which cross the offline-and-predictable line the dictation path is built on, so it must be explicit opt-in — consistent with enhance being bound to a deliberate action rather than defaulted on.
- **`Add high-confidence rules automatically` — default OFF.** Off ⇒ *every* accepted rule is a confirmed one-tap suggestion. On ⇒ enables the silent high band for candidates ≥ τ_auto that also clear the §4 guards and are not names/homographs.
- **`Also watch edits in other apps (accessibility)` — default OFF**, macOS only. Clipboard-recopy + scratchpad detection work without it; the AX read is separately gated because it reads the destination field's contents.

**Suggestion surface:** a **Dictionary Suggestions** section directly above the `dictionary` textarea in the Intelligence/dictation rows (`Settings.tsx:1477-1566`) — because that textarea *is* the rule store. Each pending suggestion is a card (`heard → written`, one-line reason, Add / Dismiss / Undo). Dismissed pairs go to `dismissedSuggestions` (G6) and never return. **Two bands, no modal ever:** medium band → a quiet non-focus-stealing toast (reuse the existing `toast` event `types.ts:489` + `useToasts`, mirroring `PasteService`'s notification pattern), auto-dismissing into the Suggestions list; high band → silent auto-add with an undoable list entry, plus a one-time "clipboard.md is now learning your corrections — review them in Settings" note so silent never means invisible.

**Default answer to silent-vs-confirmed:** confirmed one-tap by default; silent add exists only behind the secondary opt-in toggle.

## 6. Phased implementation plan

**Phase 0 — Smallest shippable slice: confirmed suggestions from clipboard re-copy + scratchpad, cross-platform, no LLM, no AX.**
1. `PendingDictation` ring buffer registered after the paste in `scratch:transcribe` (`src/main/ipc.ts:386-391`).
2. New `src/main/corrections.ts`: word-level diff + gates G1–G6, reusing `parseDictionary`/`applyDictionary` (`dictionary.ts:30-74`) and `vocabularyRules()` (`vocabulary.ts:96`).
3. Observation wiring for foreign clipboard copies via `CaptureService` (`capture/index.ts`, respecting `markSelfWrite:214`) and scratchpad edits via `scratch:save` `derivedFrom` (`ipc.ts:413-429`).
4. **Casing-only + phonetic G4** shortcut emits suggestions with no model call.
5. New IPC `dictation:rule-suggested {from,to,itemId}` → toast (`types.ts:489`); accept appends to `dictation.dictionary` via `settings:set` (`ipc.ts:266-267`).
6. `learnCorrections` toggle + Dictionary Suggestions section in `Settings.tsx:1477-1566`; `dismissedSuggestions` persistence.

**Phase 1 — Fast-LLM classifier.** Route surviving candidates through the `transforms` lane (`json:true`, cheap model, alongside `ipc.ts:339`). Add local PII pre-filter, output re-validation, and the rule-simulation check. Add τ bands.

**Phase 2 — Silent high band.** `autoAddCorrections` sub-toggle, the §4 post-classifier guards for silent eligibility, homograph repeat-count gate, and the first-run "now learning" note.

**Phase 3 — macOS AX field read.** New helper subcommand reading `kAXValue` (build on `axCopyAttribute` in `clipmd-helper.swift`, gated by the existing Accessibility grant `helper.ts:20,104`); poll shortly after paste (or add an `AXObserver`). Add `watchAxCorrections` toggle. This is the only phase that unlocks corrections made directly in other apps without re-copying, and only on macOS.

## 7. Risks & open questions

- **Detection is fragile off macOS.** Without AX, Linux (and pre-Phase-3 macOS) only learns from re-copied or scratchpad-edited text — most inline fixes are invisible. Accept this as a platform reality (`focusedWindow.ts:14-20`), not a bug.
- **AX value-read is unbuilt and unproven** for the fields users actually dictate into (web/Electron/secure fields often refuse AX). Phase 3 needs a spike before committing; a `kAXValueChangedNotification` observer vs. polling is an open engineering choice.
- **Poisoning the dictionary** is the worst failure — a bad rule silently rewrites future transcripts. The rule-simulation check and precision-over-recall thresholds mitigate but don't eliminate; provenance + easy Undo in the Suggestions list is the safety net.
- **Over-correction loop:** once learned, deterministic replacement can wrongly "fix" a legitimately different later word. Prior art's per-session revert-as-negative-signal (Wispr) is not yet in scope — open question whether to add a "user typed the original back ⇒ suppress" backoff.
- **Threshold tuning is guesswork** until there's real telemetry: N=20 s (G1), 25%/80% (G3), 0.5 Levenshtein (G4), τ_auto=0.9 / τ_suggest=0.7 are starting defaults, not validated.
- **Cost/latency of a classifier call per qualifying edit** — bounded because gates G1–G6 must all pass first, but worth measuring.
- **Open:** should Phase 0 require a light cross-session repeat-count for *all* adds (prior art suggests it), or only for homographs as designed? Leaning homograph-only to avoid never-learning single strong corrections, but this trades recall for a slightly higher false-positive floor.
