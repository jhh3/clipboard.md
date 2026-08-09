import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

/**
 * Absolute path to the `claude` CLI.
 *
 * Spawning the bare name relies on PATH, and the app's PATH is not the shell's. A
 * desktop-session or systemd launch inherits a minimal PATH that does NOT include
 * ~/.local/bin — which is where the official installer puts claude — so every agent
 * feature failed with `spawn claude ENOENT` while `claude` worked fine in a terminal.
 * That is invisible from the app: sessions simply never start and the plugin never
 * installs, with the errors buried in a log nobody reads.
 *
 * Resolved once and cached: this is on the path of every session spawn.
 */
let cached: string | null | undefined

const CANDIDATES = (): string[] => [
  join(homedir(), '.local', 'bin', 'claude'),
  join(homedir(), '.claude', 'local', 'claude'),
  '/usr/local/bin/claude',
  '/opt/homebrew/bin/claude',
  '/usr/bin/claude',
  join(homedir(), '.bun', 'bin', 'claude'),
  join(homedir(), '.volta', 'bin', 'claude')
]

/**
 * The resolved path, or 'claude' as a last resort so behaviour is unchanged where
 * PATH does work. Never throws — callers already handle the CLI being absent.
 */
export function claudeBin(): string {
  if (cached !== undefined) return cached ?? 'claude'
  // PATH first: it is authoritative when it happens to be right, and respects a
  // user who has deliberately put a different build ahead of the installed one.
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (!dir) continue
    const p = join(dir, 'claude')
    if (existsSync(p)) return (cached = p)
  }
  for (const p of CANDIDATES()) {
    if (existsSync(p)) {
      console.log(`[claude] not on PATH; using ${p}`)
      return (cached = p)
    }
  }
  console.error(
    '[claude] CLI not found on PATH or in the usual install locations — agent ' +
      'sessions and the bridge plugin will be unavailable.'
  )
  cached = null
  return 'claude'
}

/** True when we actually located the binary, rather than falling back to the name. */
export function claudeAvailable(): boolean {
  claudeBin()
  return cached !== null
}
