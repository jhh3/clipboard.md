import { app } from 'electron'
import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'

/**
 * The single door to `clipmd-helper`, the macOS side-car (src/native/mac).
 *
 * Everything macOS needs that Electron cannot do — posting ⌘V, reading the AX
 * selection, naming the frontmost app, decoding compressed audio — is a subcommand
 * here. Centralising path resolution and the trust check means the rest of the main
 * process never has to know whether the binary is present, executable, or permitted,
 * and every caller degrades the same way when it isn't.
 */

const DARWIN = process.platform === 'darwin'

/** Exit code the helper uses for "Accessibility permission not granted". */
const EXIT_UNTRUSTED = 3
/** Exit code for "there is no selection" — an expected outcome, not a failure. */
const EXIT_NO_SELECTION = 4

export interface HelperResult {
  ok: boolean
  stdout: string
  /** True when the helper reported missing Accessibility permission. */
  untrusted: boolean
  code: number | null
  error?: string
}

let cachedPath: string | null | undefined

/**
 * Packaged: electron-builder copies the binary to Contents/Resources. In dev there is
 * no resourcesPath worth speaking of, so fall back to the build output in the repo —
 * this is what makes `pnpm dev` behave like the shipped app instead of silently
 * losing every helper-backed feature.
 */
export function helperPath(): string | null {
  if (cachedPath !== undefined) return cachedPath
  if (!DARWIN) return (cachedPath = null)
  const candidates = [
    join(process.resourcesPath ?? '', 'clipmd-helper'),
    join(app.getAppPath(), 'resources', 'mac', 'clipmd-helper'),
    join(app.getAppPath(), '..', 'resources', 'mac', 'clipmd-helper')
  ]
  cachedPath = candidates.find((p) => existsSync(p)) ?? null
  if (!cachedPath) {
    console.error(
      '[mac] clipmd-helper not found — paste injection, selection capture and local ' +
        'dictation are unavailable. Run src/native/mac/build.sh.'
    )
  }
  return cachedPath
}

export function helperAvailable(): boolean {
  return helperPath() !== null
}

/**
 * Run a subcommand. Never throws: callers are all on interactive paths where the
 * right answer to "the helper failed" is to degrade, not to surface a stack trace.
 */
export function runHelper(args: string[], timeout = 5000): Promise<HelperResult> {
  return new Promise((resolve) => {
    const path = helperPath()
    if (!path) {
      resolve({ ok: false, stdout: '', untrusted: false, code: null, error: 'helper not installed' })
      return
    }
    execFile(path, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      // execFile puts the child's exit status on `code` as a number, but reuses the
      // same field for spawn failures as a string ('ENOENT'), so it needs narrowing
      // rather than a cast — the exit codes are how we tell "untrusted" from "no
      // selection" from "the binary isn't there".
      const raw: unknown = (err as { code?: unknown } | null)?.code
      const numeric = typeof raw === 'number' ? raw : null
      resolve({
        ok: !err,
        stdout: stdout ?? '',
        untrusted: numeric === EXIT_UNTRUSTED,
        code: numeric,
        error: err ? (stderr || err.message).trim() : undefined
      })
    })
  })
}

/**
 * Accessibility trust. `prompt: true` shows the system dialog that adds us to the
 * Accessibility list — without it the user has no affordance to grant anything, so it
 * is the onboarding path, not a nag. macOS itself shows it at most once per binary.
 */
export async function isTrusted(prompt = false): Promise<boolean> {
  const result = await runHelper(prompt ? ['trust', '--prompt'] : ['trust'])
  return result.stdout.trim() === 'trusted'
}

/** Post ⌘V to the frontmost app. False means the caller must fall back to a toast. */
export async function macPaste(): Promise<{ injected: boolean; untrusted: boolean }> {
  const result = await runHelper(['paste'], 3000)
  if (!result.ok && !result.untrusted) console.error('[mac] paste failed:', result.error)
  return { injected: result.ok, untrusted: result.untrusted }
}

export interface MacSelection {
  text: string | null
  untrusted: boolean
}

/**
 * The current selection in the frontmost app, via the helper's AX → menu → ⌘C chain.
 *
 * The timeout is generous because tier 3 waits on a pasteboard round trip, but "no
 * selection" is answered fast by the menu-item probe rather than by timing out.
 */
export async function macSelectedText(): Promise<MacSelection> {
  const result = await runHelper(['selected-text'], 4000)
  if (result.untrusted) return { text: null, untrusted: true }
  if (!result.ok) {
    // "nothing is selected" is the normal miss, not something to log as an error.
    if (result.code !== EXIT_NO_SELECTION) console.error('[mac] selected-text failed:', result.error)
    return { text: null, untrusted: false }
  }
  const text = result.stdout
  return { text: text.length > 0 ? text : null, untrusted: false }
}

/** Frontmost app as `name` + `bundleId`; either may be empty. */
export async function macFrontmost(): Promise<{ name: string; bundleId: string } | null> {
  const result = await runHelper(['frontmost'], 1000)
  if (!result.ok) return null
  const [name = '', bundleId = ''] = result.stdout.trim().split('\t')
  if (!name && !bundleId) return null
  return { name, bundleId }
}

/** Decode any AVFoundation-readable container to 16k mono WAV. Throws on failure. */
export async function macDecodeAudio(input: string, output: string): Promise<void> {
  const result = await runHelper(['decode-audio', input, output], 60_000)
  if (!result.ok) throw new Error(result.error || 'audio decode failed')
}
