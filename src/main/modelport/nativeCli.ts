import { app } from 'electron'
import { existsSync, mkdirSync } from 'fs'
import { createRequire } from 'module'
import { dirname, join, sep } from 'path'
import { MACOS, WIN32 } from '../platform'

/**
 * Resolve the CLI binaries the subscription-lane SDKs spawn.
 *
 * Both SDKs work out their executable's path from their own module location. In a
 * packaged build that location is inside `app.asar`, and app.asar is a FILE — Electron
 * fakes a directory for `require` and `fs`, but `child_process.spawn` performs a real
 * syscall and gets ENOTDIR. The result: both subscription providers fail on every
 * request in the installed app while working perfectly in dev.
 *
 * This is the sqlite-vec failure mode again (docs/DESIGN.md: "native modules must be
 * verified in a PACKAGED build"), so the fix is the same shape — find the real
 * unpacked path and hand it to the SDK explicitly.
 */

const require_ = createRequire(__filename)

/**
 * A neutral working directory for spawned AI agents.
 *
 * Both subscription CLIs are coding agents: they inherit our TCC identity and, given
 * an interesting cwd, will discover project settings and walk the filesystem. That
 * produced a stream of "clipboard.md would like to access your Documents/Desktop/…"
 * prompts attributed to us — for work that is only ever "summarise this clipboard
 * text". Pointing them at an empty scratch directory under userData means there is
 * nothing to find and nothing to ask about.
 *
 * Enrichment passes clip content in the prompt and never needs the user's files. The
 * one exception is image enrichment, which allows the Read tool and passes an
 * absolute path into our own images directory.
 */
export function agentScratchDir(): string {
  const dir = join(app.getPath('userData'), 'agent-scratch')
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Map a path inside app.asar to its app.asar.unpacked twin, when one exists.
 *
 * Only rewrites when the target is actually present, so an unexpected packaging
 * layout degrades to the SDK's own resolution rather than to a path that is
 * confidently wrong.
 */
export function unpackedPath(p: string): string {
  if (!p.includes(`app.asar${sep}`)) return p
  const unpacked = p.replace(`app.asar${sep}`, `app.asar.unpacked${sep}`)
  return existsSync(unpacked) ? unpacked : p
}

/**
 * Locate a platform-specific CLI shipped as an optional dependency
 * (`@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`, `@openai/codex-darwin-arm64/codex`).
 *
 * Returns undefined when it can't be found, which leaves the SDK to resolve its own
 * path — correct in dev, where there is no asar and nothing to rewrite.
 */
export function resolveVendoredCli(packagePrefix: string, binary: string): string | undefined {
  const platform = MACOS ? 'darwin' : WIN32 ? 'win32' : 'linux'
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  const candidates = [`${packagePrefix}-${platform}-${arch}`, `${packagePrefix}-${platform}-${arch}-musl`]
  // Windows executables carry an extension, and these packages ship `claude.exe`, not
  // a bare `claude`. Every probe below therefore missed on win32 and the function
  // returned undefined unconditionally — the SDK then resolved its own path, which
  // points inside app.asar, and the subscription lanes failed on every request in the
  // packaged app. Appended only on win32, so the linux and darwin names are the exact
  // strings they were.
  const names = WIN32 ? [`${binary}.exe`, binary] : [binary]
  for (const pkg of candidates) {
    try {
      const manifest = require_.resolve(`${pkg}/package.json`)
      for (const name of names) {
        const candidate = unpackedPath(join(dirname(manifest), name))
        if (existsSync(candidate)) return candidate
      }
    } catch {
      /* not installed for this platform/arch — try the next shape */
    }
  }
  return undefined
}
