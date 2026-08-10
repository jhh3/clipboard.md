import { execFile } from 'child_process'
import { promisify } from 'util'

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

const WANTED = ['OPENAI_API_KEY', 'GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'E2B_API_KEY']

export async function importShellEnv(): Promise<void> {
  if (process.platform === 'win32') return
  // Already have everything? Don't spawn a shell for nothing.
  if (WANTED.every((k) => process.env[k])) return

  const shell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash')
  try {
    // -ilc: interactive login shell so rc files run. A unique delimiter frames the
    // env dump so shell banners/rc chatter around it can't corrupt the parse.
    const marker = '__CLIPMD_ENV__'
    const { stdout } = await execFileP(shell, ['-ilc', `echo ${marker}; env; echo ${marker}`], {
      timeout: 5000,
      maxBuffer: 4 * 1024 * 1024,
      // A login shell that tries to read from the tty would hang; detach stdin.
      windowsHide: true
    })
    const body = stdout.split(marker)[1] ?? ''
    let imported = 0
    for (const line of body.split('\n')) {
      const eq = line.indexOf('=')
      if (eq < 1) continue
      const key = line.slice(0, eq)
      // FILL, never overwrite. `process.env[key]` already being set means the app
      // was launched with it (e.g. from a terminal, or a systemd unit that forwarded
      // it) — that value is more intentional than the rc default, so leave it. And a
      // key set in Settings wins over the environment regardless (see keyFor()), so
      // the precedence end to end is: Settings > launch env > shell rc.
      if (!WANTED.includes(key) || process.env[key]) continue
      const value = line.slice(eq + 1)
      if (!value) continue
      process.env[key] = value
      imported++
    }
    if (imported > 0) console.log(`[env] imported ${imported} API key(s) from the shell environment`)
  } catch (err) {
    // No shell, timeout, or a hostile rc — the app still works via Settings keys
    // and the on-disk claude/codex login. Log once; never fail startup over it.
    console.log(`[env] could not read the shell environment: ${(err as Error).message.split('\n')[0]}`)
  }
}
