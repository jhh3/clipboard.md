import { existsSync } from 'fs'
import { createRequire } from 'module'
import { dirname, join, sep } from 'path'

/**
 * Resolve the CLI binaries the subscription-lane SDKs spawn.
 *
 * Both SDKs work out their executable's path from their own module location. In a
 * packaged build that location is inside `app.asar`, and app.asar is a FILE — Electron
 * fakes a directory for `require` and `fs`, but `child_process.spawn` performs a real
 * syscall and gets ENOTDIR. The result: both subscription providers fail on every
 * request in the installed app while working perfectly in dev.
 *
 * This is the sqlite-vec failure mode again (DESIGN.md: "native modules must be
 * verified in a PACKAGED build"), so the fix is the same shape — find the real
 * unpacked path and hand it to the SDK explicitly.
 */

const require_ = createRequire(__filename)

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
  const platform =
    process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'win32' : 'linux'
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  const candidates = [`${packagePrefix}-${platform}-${arch}`, `${packagePrefix}-${platform}-${arch}-musl`]
  for (const pkg of candidates) {
    try {
      const manifest = require_.resolve(`${pkg}/package.json`)
      const candidate = unpackedPath(join(dirname(manifest), binary))
      if (existsSync(candidate)) return candidate
    } catch {
      /* not installed for this platform/arch — try the next shape */
    }
  }
  return undefined
}
