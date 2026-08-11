# Learn-from-Corrections — OSS Research & Improvement Plan

Confirmed my grounding. I have the actual gate stack (`correctionsMatch.ts` / `corrections.ts`), the apply engine (`dictionary.ts`, already `\b`-anchored), the two live signals and their call sites, and the deps (no phonetic lib yet; `double-metaphone` would be a zero-dep add). Here is the plan.

---

# Learn-from-Corrections: Improvement Plan (deltas, not a redesign)

Confidence tags: **[H]** high, **[M]** medium, **[L]** low. Grounding paths are absolute.

## 1. Verdict on robustness

**We are doing this more rigorously than the entire OSS field, and we're missing exactly the one thing that field's only real player has.** **[H]**

Ground truth from the research: of every open-source dictation tool surveyed — VoiceInk, Handy, Whispering, superwhisper, WhisperDictation — **none learn from post-paste edits at all.** They bias *before* transcription (custom-word lists as `initial_prompt`) or apply *manual, static* find/replace. "Correction" in OSS almost always means spoken self-correction ("scratch that") caught pre-paste. Only two tools anywhere do the real loop: closed **Wispr Flow** (AX field read-back + silent dictionary growth) and GPLv3 **TypeWhisper** ("auto-learns high-confidence local single-word corrections; skips rewrites and deletions").

What we do **well** — and better than TypeWhisper's described heuristic:
- **Precision-first with a decisive rule-simulation gate** (`corrections.ts:134-135`): the proposed rule must reproduce the edit exactly and touch nothing else. This is stronger than anything documented in the OSS peers and is the right core.
- **Localized single-substitution isolation** (`correctionsMatch.ts:18`) matches TypeWhisper's philosophy exactly (single-word, local, skip multi-word rewrites/deletions).
- **Boundary-anchored, longest-first, case-insensitive apply** (`dictionary.ts:62-73`) — this is precisely the mature-tool pattern (Vim `\<foo\>`, Word "whole words only", VoiceInk's length-sorted regex). Already correct; no change needed.
- **Opt-in, offline, deterministic, with a dismissed-set** — the privacy posture is right.

What's **missing**:
- **Recall** — our two signals (foreign re-copy, scratchpad edit) miss the dominant case: inline fixes in the destination app. This is the known gap and it's the *only* gap Wispr actually solved (via AX read-back). **[H]**
- **Phonetics quality** — homegrown Soundex (`correctionsMatch.ts:113`) is the weakest documented encoder (low precision, English-surname-tuned). **[H]**
- **A too-loose distance gate** — normalized Levenshtein ≤ 0.5 admits pairs sharing only half their characters. **[H]**
- **Validated thresholds** — 20 s / 0.5 / PENDING_MAX=3 are guesses. **[M]**

Net: the *engine* is arguably best-in-class-open; the *coverage* is the deficit.

## 2. Concrete improvements to the existing implementation (prioritized)

### P1 — Replace Soundex with Double Metaphone. **[H] clear win, small effort**
- **Change:** add the zero-dep `double-metaphone` package (wooorm/`words`, TS-native, ESM); rewrite the phonetic half of `soundsAlike` (`correctionsMatch.ts:72-79`) and delete the homegrown `soundex`/`SOUNDEX_CODE` (`:104-124`). Two-tier match: `primary(a)===primary(b)` = strong; `primary` matches the other token's `alternate` = weak. The dual-code output *is* a natural confidence gate.
- **Why:** Phonetics research is unambiguous — Double Metaphone is the general-purpose recommendation, a strict precision+recall improvement over Soundex, and models exactly the digraph/silent-letter errors dictation produces (knight/night, cite/site). Soundex is "low precision, lots of false collisions."
- **Effort:** ~1 hr incl. test updates (`correctionsMatch.test.ts` already exists).

### P2 — Tighten the loose distance gate to Jaro-Winkler. **[H] clear win, small effort**
- **Change:** in `soundsAlike`, replace `levRatio(h,w) <= 0.5` with **Jaro-Winkler ≥ 0.85** (tokens > 4 chars), **≥ 0.90** (tokens ≤ 4 chars, where JW's prefix bonus is least reliable). Keep a Levenshtein-distance ≤ 1 fast-accept path.
- **Why:** research: JW is purpose-built for short strings/names with a prefix bonus that matches ASR reality (onset right, tail flubbed); industry defaults are 0.80–0.90 (Splink: 0.9 typos, 0.8 nicknames). Normalized-Lev ≤ 0.5 is "far too loose."
- **Reconciliation (important):** research recommends phonetic-AND-surface as a strict gate. **Do NOT make it a strict AND.** English encoders butcher domain jargon ("kubernetes", "kubectl") — a hard phonetic requirement would *lose* the jargon corrections that are our highest-value case. Keep an **OR**: accept if `(Double Metaphone match)` **OR** `(Jaro-Winkler ≥ 0.92)`. This tightens the current sloppy 0.5 floor while preserving jargon recall. The rule-simulation gate remains the backstop against a bad OR-branch. **[M]**
- **Effort:** ~1 hr. Use `natural` (already-available JW) or a ~30-line JW impl; prefer a tiny impl over pulling `natural`'s weight.

### P3 — Keep the deterministic path; deprioritize the Phase-1 LLM classifier. **[M]**
- **Change:** do NOT build the fast-LLM classifier next. With P1+P2 hardening the gates plus the existing rule-simulation, the deterministic suggest-band is strong enough on its own.
- **Why:** the LLM was designed as the precision backstop *before* the gates were this good; it adds cost, latency, and a text-leaves-the-machine step. Reserve it strictly for a future *silent auto-add* band (which isn't built) — a one-tap confirmed suggestion doesn't need a model to vouch for it. This is the "drop the speculative" call.

### P4 — Gate improvements that are already correct (document, don't rebuild). **[H]**
- **Word-boundary anchoring** on learned rules: already done (`dictionary.ts:65-67`). Matches the mature-tool consensus. No change.
- **Single-candidate / homograph safety:** every add today is one-tap confirmed, so the homograph risk (their/there) is already user-gated. The research's "repeat-count before auto-add" only matters *if* silent auto-add ships — defer it to that band, don't add it now. **[M]**
- **Context-window (±1-2 words) conditioning:** **skip.** It fights our global-rule model (VoiceInk's replacements are global too), and rule-simulation already guards learn-time over-match. Speculative complexity. **[M]**

### P5 — Instrument the guessed thresholds instead of re-guessing them. **[M]**
- **Change:** add local (never-uploaded) counters around `WINDOW_MS` (`corrections.ts:33`) and the distance gate — e.g., log how many candidates die at each gate and at what latency the matched edits actually arrive. Widen the 20 s window to ~30–45 s only if data shows real edits landing late; leave PENDING_MAX=3.
- **Why:** Wispr validates against a full-field diff we don't have; without telemetry these stay guesses. Cheap to measure, honest to defer.

## 3. Covering more surfaces

Surface × observation mechanism (mapped to what clipboard.md can actually do). ✅ works · ⚠️ partial · ❌ no.

| Surface | Clipboard re-copy (have) | Scratchpad / owned UI (have) | AX read `kAXValue` (Phase 3, unbuilt) | AX observer | Keystroke tap (won't build) |
|---|---|---|---|---|---|
| **Native Cocoa field** | ⚠️ only if user re-copies | ❌ (edit isn't in our app) | ✅ full text **+ caret** — clean localized diff | ✅ push on edit | ✅ (rejected: privacy) |
| **Web / Electron field** | ⚠️ only if user re-copies | ❌ | ⚠️ full text **only after** setting `AXManualAccessibility`; selection reads `{0,0}` → whole-field diff, no caret | ⚠️ noisier | ✅ (rejected) |
| **Terminal TUI (WezTerm + Claude Code)** | ❌ TUIs don't map ⌘A/⌘C to select-all/copy | ❌ | ❌ **no AX text surface at all** | ❌ | ✅ **only mechanism that works** (rejected) |

Best available option **per surface**:
- **Native Cocoa:** the AX `kAXValue` read (Phase 3) is the clear winner — it's the one surface with caret-accurate, push-notified observation, and it's exactly Wispr's mechanism. Biggest single recall unlock. **[H]**
- **Web/Electron (VS Code, Slack, Obsidian, Chrome):** AX whole-field read after flipping `AXManualAccessibility` via `AXUIElementSetAttributeValue`. You get the whole value but **not** the caret (Chromium reports `{0,0}`), so edit *localization* degrades to a full-field diff — which our `singleSubstitution` already does token-wise, so this is fine. Caveat: setting the attribute can fail with `kAXErrorAttributeUnsupported` on some Electron versions; needs a spike. **[M]**
- **Terminal TUI:** see blunt verdict.

### Blunt verdict on the terminal case
**Not capturable without keystroke logging. Full stop.** **[H]**
- WezTerm renders glyphs to a GPU surface and instantiates **no AppKit text control** — there is nothing for AX to read, no observer to attach, and no standard selection to synthesize-copy. This is verified three ways: WezTerm's own accessibility issue (#913) is still an unimplemented design discussion, macOS Dictation itself fails silently in WezTerm while working in Terminal.app/iTerm2 (#4592), and the Warp accessibility issue documents the identical GPU-surface blind spot.
- Even Terminal.app/iTerm2 (which *do* expose an `AXTextArea`) only give you the **whole screen**, not the input line — Claude Code's prompt box is painted into the same character grid, so there's no field-scoped value, no caret, and the natural fix (backspace/retype/Enter) leaves no diffable artifact.
- **Does any OSS tool solve it?** No. None of the OSS tools observe post-paste edits *anywhere*, let alone in a terminal. The *only* mechanism that spans all terminals is a system-wide `CGEventTap` — which is exactly why closed Wispr Flow ships one, and exactly the privacy line we've said we won't cross (Input Monitoring TCC, sees every password, fragile edit-reconstruction; Wispr's own tap ate 145 spacebars in 10 min when its key-tracking desynced).

**Recommendation for terminals: declare it explicitly out of scope for passive observation, and route around it** — capture terminal-bound corrections in a surface we *own* (§4). Don't waste effort trying to scrape WezTerm.

## 4. New signals worth adding (ranked by value/effort)

1. **AX whole-field read on macOS (native + Electron) — Phase 3.** **[H] highest value.** The one thing Wispr does that we don't, and the only mechanism that lifts recall on the surfaces users actually dictate into. New helper subcommand doing `axCopyAttribute(element, kAXValueAttribute)` (the plumbing for `selected-text` already exists in `clipmd-helper.swift`); poll ~1–3 s after paste, diff against the pending `original`. For Electron targets, set `AXManualAccessibility` first. Value: high. Effort: medium (helper subcommand + Electron attribute + a spike on which fields refuse AX).

2. **An explicit "fix last dictation" affordance in our own UI.** **[H] high value / low effort.** Editing a transcription clip already flows through `considerScratchEdit` (`ipc.ts:433`) — a fully observable, before/after, no-OS-scraping signal. Surface a one-tap "correct last dictation" that opens that clip in the scratchpad. This is the *answer to the terminal problem*: the user who dictated into WezTerm and had to retype can instead correct it in a surface we own, and we learn the rule with zero AX and zero keystroke logging. Reuses existing wiring. **This is the single best recall/effort ratio on the list.**

3. **Capture corrections in the palette ask-row / any owned input.** **[M].** Same principle as #2 — any text field clipboard.md itself renders is fully observable with no accessibility grant. If dictation can target our own palette/scratchpad, edits there are free training signal. Low effort where the surface already exists.

4. **"User typed the original back ⇒ suppress" negative signal (Wispr's revert-as-signal).** **[L] defer.** Only meaningful once *silent auto-add* exists; today every rule is user-confirmed, so a bad suggestion is declined, not silently applied. Park until an auto-add band is on the table.

5. **Cross-session repeat-count as a confidence booster (not a requirement).** **[L].** Useful only as the homograph guard for a future auto-add band. Requiring repeats now would trade away our ability to learn a single strong correction — don't.

## 5. What NOT to do

- **Do not add keystroke logging / `CGEventTap`.** It's the only thing that reaches WezTerm, and it's disqualified: Input Monitoring TCC, sees every keystroke system-wide incl. passwords, fragile edit reconstruction (arrow keys, readline bindings, IME), and it sits in the event path where it can drop real keystrokes (Wispr's spacebar bug). Non-negotiable privacy line. **[H]**
- **Do not synthesize ⌘A/⌘C to read fields.** Destructive (clobbers the user's real clipboard, moves the caret), TUIs don't map those keys to select-all/copy, and it has the async ownership race this repo *already* got bitten by ("wait for clipboard ownership, stop lying about failure", commit 4f73e4f). Poor observation mechanism everywhere. **[H]**
- **Do not make the phonetic test a strict AND gate** (research's literal recommendation). It would drop domain jargon that no English encoder pronounces. Keep the OR with a *tight* JW floor. **[M]**
- **Do not chase sherpa hotword/contextual biasing** to "fix it upstream." `dictionary.ts:4-14` already documents why: `modified_beam_search` hallucinates/empties ~20% on our shipped Parakeet model. Post-decode correction is the right layer.
- **Do not build per-app-scoped dictionary rules yet.** VoiceInk's replacements are global; scoping is speculative complexity without evidence (we already have `styleForApp` for the one place per-app matters). **[M]**
- **Do not add the fast-LLM classifier for the suggest band.** Cost/latency/text-egress for a step the hardened deterministic gates + one-tap confirmation already cover. **[M]**
- **Do not resurrect AT-SPI on Linux** — the design doc already correctly dropped it; the codebase can't read foreign field text off macOS (`focusedWindow.ts:14-20`). **[H]**
- **Do not chase TypeWhisper's premium-autocorrect pattern** — its open/closed boundary is unclear and gating learned corrections behind a paywall is off-strategy.

## 6. Recommended next 2–3 concrete steps

1. **Ship the gate hardening (P1 + P2).** Add `double-metaphone`, replace `soundex` with dual-code matching, and swap normalized-Lev ≤ 0.5 for Jaro-Winkler ≥ 0.85 / ≥ 0.90-short with a jarowinkler-≥0.92-OR-phonetic structure, all in `src/main/correctionsMatch.ts`. Fully unit-testable against the existing `src/main/correctionsMatch.test.ts`. Small, self-contained, clear win, no new surfaces. **Do this first.**

2. **Add the owned-surface correction affordance (§4 #2).** A one-tap "correct last dictation" that opens the transcription clip in the scratchpad, feeding the already-wired `considerScratchEdit` path (`src/main/ipc.ts:433`). This is the pragmatic answer to the WezTerm/terminal blind spot and the best recall-per-effort move — no AX, no keystrokes, no new permissions.

3. **Spike Phase 3 AX `kAXValue` read on macOS** (native + Electron via `AXManualAccessibility`) as the real recall unlock, and add lightweight local threshold instrumentation (P5) at the same time so the 20 s window and distance floors get validated against actual edit-arrival data instead of re-guessed. Gate the AX read behind its own opt-in toggle; accept that it will never help terminals and that Linux stays limited to the two owned signals.

Key files: `/Users/jhh3/Documents/code/clipboard.md/src/main/correctionsMatch.ts`, `/Users/jhh3/Documents/code/clipboard.md/src/main/corrections.ts`, `/Users/jhh3/Documents/code/clipboard.md/src/main/dictionary.ts` (apply engine — already boundary-anchored, leave alone), `/Users/jhh3/Documents/code/clipboard.md/src/main/ipc.ts` (call sites 399/433), `/Users/jhh3/Documents/code/clipboard.md/src/native/mac/clipmd-helper.swift` (Phase 3 subcommand), `/Users/jhh3/Documents/code/clipboard.md/docs/DICTATION-LEARNING.md` (design doc to update: demote the LLM classifier, note the terminal verdict).
