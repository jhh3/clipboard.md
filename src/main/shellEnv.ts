import { execFile } from 'child_process'
import { PROVIDER_ENV_VARS } from './modelport/providerEnv'
import { promisify } from 'util'
import { MACOS, WIN32 } from './platform'

const execFileP = promisify(execFile)

/**
 * Import the user's shell environment on macOS so exported API keys are found.
 *
 * A GUI app launched from Finder / the login item / `open` inherits launchd's
 * minimal environment, NOT the one your `~/.zshrc` sets up — so `OPENAI_API_KEY`
 * exported in your shell is invisible to the app, and the only symptom is "no
 * providers available" while `echo $OPENAI_API_KEY` in a terminal prints one.
 * (This is the same problem VS Code solves with shell-environment resolution.)
 *
 * We ask the login shell to print its environment and copy across ONLY the small
 * set of keys the app cares about, and only when they aren't already set — so an
 * app started from a terminal, or one where the user set keys in Settings, is
 * untouched. Best-effort and bounded: a slow or broken rc must not delay startup,
 * so we time out and move on.
 *
 * Linux has exactly the same problem and this used to skip it, on the assumption
 * that the systemd user session carries the environment. It carries the SESSION
 * environment — DISPLAY, WAYLAND_DISPLAY, XAUTHORITY — and not one thing exported
 * from a shell rc, so an autostarted app saw no API keys at all. Verified directly:
 * `systemctl --user show-environment` lists neither key while the same shell prints
 * both.
 */

/**
 * Derived from the provider table rather than restated, because restating it already
 * broke once: adding Fireworks to the key lookup without adding it here meant the
 * login shell was never asked for FIREWORKS_API_KEY. Worse, this function returns
 * early when every WANTED name is already set — and the old three were — so the shell
 * import was skipped entirely and the key silently never arrived in Settings.
 *
 * ANTHROPIC_API_KEY and E2B_API_KEY are not provider-table entries: the Agent SDK and
 * the sandbox read them from the environment themselves.
 */
const WANTED = [...Object.values(PROVIDER_ENV_VARS), 'ANTHROPIC_API_KEY', 'E2B_API_KEY']
const MARKER = '__CLIPMD_ENV__'

/**
 * Dump a shell's environment between two markers.
 *
 * Crucially, returns stdout even when the shell EXITS NON-ZERO. An interactive rc
 * routinely exits non-zero — an instant-prompt theme (powerlevel10k), a trailing
 * command in ~/.zshrc, `set -e` chatter — and execFile rejects on any non-zero exit,
 * throwing away the perfectly good `env` output already on stdout. That is why the
 * import silently produced nothing on a normal machine: the env was printed, then the
 * shell returned 1 and we discarded it. The failed process still carries its stdout.
 */
async function dumpEnv(shell: string, flag: string): Promise<string> {
  try {
    const { stdout } = await execFileP(shell, [flag, `echo ${MARKER}; env; echo ${MARKER}`], {
      timeout: 5000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true
    })
    return stdout
  } catch (err) {
    const out = (err as { stdout?: string }).stdout
    if (out) return out // non-zero exit, but the env dump made it out first
    throw err
  }
}

/** Fill WANTED keys from an `env` dump body. Returns how many were newly set. */
function absorb(body: string): number {
  let imported = 0
  for (const line of body.split('\n')) {
    const eq = line.indexOf('=')
    if (eq < 1) continue
    const key = line.slice(0, eq)
    // FILL, never overwrite. `process.env[key]` already being set means the app was
    // launched with it (a terminal, a systemd unit that forwarded it) — more
    // intentional than the rc default, so leave it. A key set in Settings wins over the
    // environment regardless (see keyFor()), so end to end: Settings > launch env > rc.
    if (!WANTED.includes(key) || process.env[key]) continue
    const value = line.slice(eq + 1)
    if (!value) continue
    process.env[key] = value
    imported++
  }
  return imported
}

export async function importShellEnv(): Promise<void> {
  if (WIN32) {
    // Correct to skip, and worth saying so. A Windows GUI process inherits
    // HKCU\Environment, so there is no login-shell gap to close — but the guard also
    // has to stay, because process.env.SHELL IS set under Git Bash, and removing it
    // would spawn MSYS bash with a Unix `env` on a machine that has neither.
    console.log('[env] Windows inherits the user environment directly; no shell import needed')
    return
  }
  // Already have everything? Don't spawn a shell for nothing.
  if (WANTED.every((k) => process.env[k])) return

  const shell = process.env.SHELL || (MACOS ? '/bin/zsh' : '/bin/bash')
  // -ilc first: an interactive login shell runs ~/.zshrc / ~/.bashrc, where most people
  // export keys. -lc is the fallback: a login shell runs ~/.zprofile / ~/.zshenv (zsh
  // does NOT read .zshrc non-interactively), catching keys set there and covering the
  // case where the interactive shell couldn't run at all.
  let imported = 0
  for (const flag of ['-ilc', '-lc']) {
    let body: string
    try {
      body = (await dumpEnv(shell, flag)).split(MARKER)[1] ?? ''
    } catch (err) {
      console.log(`[env] ${shell} ${flag}: ${(err as Error).message.split('\n')[0]}`)
      continue
    }
    imported += absorb(body)
    if (WANTED.every((k) => process.env[k])) break // got them all; skip the fallback
  }
  if (imported > 0) console.log(`[env] imported ${imported} API key(s) from the shell environment`)
}
