import { existsSync } from 'fs'
import { homedir } from 'os'
import { extname, posix, win32 } from 'path'
import type { Platform } from './platform'
import { currentPlatform } from './platform'

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
let cached: ResolvedBin | null | undefined

export interface ResolvedBin {
  path: string
  /**
   * True for a Windows `.cmd`/`.bat` wrapper.
   *
   * Node ≥18.20 refuses to `spawn`/`execFile` a batch file without a shell — it
   * throws EINVAL, which is the CVE-2024-27980 fix, not a bug to work around. A
   * caller that ignores this gets "spawn EINVAL" from a path that exists, which
   * reads like a corrupt install rather than a missing flag.
   *
   * We prefer a real `.exe` precisely so this stays false almost always.
   */
  needsShell: boolean
}

/**
 * `path.join` for the TARGET platform, not the running one.
 *
 * Every function in this file is pure over a platform argument so it can be tested
 * for all three from any one of them — and a bare `join` would quietly defeat that
 * by emitting `C:\Users\Ada/claude.exe` when the test runs on Linux. It is also the
 * correct call at runtime, since the branch that uses win32 only runs on win32.
 */
function joiner(platform: Platform): (...parts: string[]) => string {
  return platform === 'win32' ? win32.join : posix.join
}

/**
 * Extensions to try, in order, when probing a directory for the CLI.
 *
 * Windows PATH lookup is extension-based: `claude` on disk is `claude.exe` or the
 * npm-generated `claude.cmd`, and `existsSync(join(dir,'claude'))` finds NEITHER.
 * That is the whole reason agent features could never work on Windows — the probe
 * looked for a file that does not exist there under any install method.
 *
 * `.exe` first, deliberately: a `.cmd` costs us a shell (see needsShell) and a shell
 * costs us argument-quoting correctness on a path that carries user text.
 */
export function binExtensions(platform: Platform): string[] {
  return platform === 'win32' ? ['.exe', '.cmd', '.bat', '.ps1', ''] : ['']
}

/**
 * Where the CLI is installed when it is not on PATH, per platform.
 *
 * Kept as a pure function of (platform, home) so the Linux and macOS lists can be
 * asserted byte-identical to what shipped before — this file is on the path of every
 * agent spawn, and a reordering here changes which build of claude a user runs.
 */
export function binCandidates(platform: Platform, home: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const join = joiner(platform)
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA ?? join(home, 'AppData', 'Local')
    const appData = env.APPDATA ?? join(home, 'AppData', 'Roaming')
    return [
      join(localAppData, 'Programs', 'claude', 'claude.exe'),
      join(home, '.local', 'bin', 'claude.exe'),
      join(home, '.claude', 'local', 'claude.exe'),
      // npm/pnpm global installs generate a .cmd shim rather than an .exe.
      join(appData, 'npm', 'claude.cmd'),
      join(home, '.bun', 'bin', 'claude.exe')
    ]
  }
  return [
    join(home, '.local', 'bin', 'claude'),
    join(home, '.claude', 'local', 'claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
    '/usr/bin/claude',
    join(home, '.bun', 'bin', 'claude'),
    join(home, '.volta', 'bin', 'claude')
  ]
}

/**
 * The resolution itself, with the filesystem injected so it can be tested for all
 * three platforms from any one of them.
 *
 * Returns null when nothing was found; callers fall back to the bare name, which is
 * still correct wherever PATH happens to work.
 */
export function resolveClaudePath(
  platform: Platform,
  env: NodeJS.ProcessEnv,
  home: string,
  exists: (p: string) => boolean
): ResolvedBin | null {
  // PATH first: it is authoritative when it happens to be right, and respects a
  // user who has deliberately put a different build ahead of the installed one.
  //
  // Split on path.delimiter, not ':'. On Windows the separator is ';' and every
  // entry contains a drive letter, so splitting on ':' shreds `C:\Program Files\…`
  // into `C` and `\Program Files\…` — every probe then misses, silently.
  const sep = platform === 'win32' ? ';' : ':'
  const join = joiner(platform)
  for (const dir of (env.PATH ?? env.Path ?? '').split(sep)) {
    if (!dir) continue
    for (const ext of binExtensions(platform)) {
      const p = join(dir, `claude${ext}`)
      if (exists(p)) return { path: p, needsShell: isBatch(p) }
    }
  }
  for (const p of binCandidates(platform, home, env)) {
    if (exists(p)) return { path: p, needsShell: isBatch(p) }
  }
  return null
}

function isBatch(p: string): boolean {
  const ext = extname(p).toLowerCase()
  return ext === '.cmd' || ext === '.bat'
}

function resolve(): ResolvedBin | null {
  if (cached !== undefined) return cached
  cached = resolveClaudePath(currentPlatform(), process.env, homedir(), existsSync)
  if (cached) {
    console.log(`[claude] using ${cached.path}${cached.needsShell ? ' (batch shim; spawned through a shell)' : ''}`)
  } else {
    console.error(
      '[claude] CLI not found on PATH or in the usual install locations — agent ' +
        'sessions and the bridge plugin will be unavailable.'
    )
  }
  return cached
}

/**
 * The resolved path, or 'claude' as a last resort so behaviour is unchanged where
 * PATH does work. Never throws — callers already handle the CLI being absent.
 */
export function claudeBin(): string {
  return resolve()?.path ?? 'claude'
}

/**
 * Spawn options every `claude` call site must spread.
 *
 * `{ shell: true }` when the resolved path is a .cmd/.bat shim, and `{}` otherwise —
 * so the Linux and macOS call sites pass an empty object and are byte-for-byte
 * unchanged, while Windows stops throwing EINVAL from a file that plainly exists.
 */
export function claudeSpawnOpts(): { shell?: boolean } {
  return resolve()?.needsShell ? { shell: true } : {}
}

/** True when we actually located the binary, rather than falling back to the name. */
export function claudeAvailable(): boolean {
  return resolve() !== null
}
