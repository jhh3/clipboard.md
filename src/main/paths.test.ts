import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { binCandidates, binExtensions, resolveClaudePath } from './claudeBin'
import { dataDir, copyCommand } from '../mcp/server'
import { hooksJson } from './agentPlugin'

/**
 * All of this is string logic, so all of it can be checked for every platform from
 * any one of them. That matters more here than anywhere else in the port: these
 * functions decide which binary gets spawned and where the database is looked for,
 * and both fail SILENTLY when wrong — a missing CLI disables agent features with the
 * error in a log nobody reads, and a wrong data directory makes the MCP server tell
 * a daily user to "run the app once first".
 *
 * The linux and darwin expectations below are the literal values that shipped.
 */
const HOME = '/home/ada'
const WINHOME = 'C:\\Users\\Ada'

describe('claude binary resolution', () => {
  it('probes no extensions off Windows', () => {
    expect(binExtensions('linux')).toEqual([''])
    expect(binExtensions('darwin')).toEqual([''])
  })

  it('prefers .exe over the .cmd shim on Windows', () => {
    // A .cmd costs a shell (Node ≥18.20 throws EINVAL without one) and a shell costs
    // argument-quoting correctness, so the real executable must win when both exist.
    const exts = binExtensions('win32')
    expect(exts[0]).toBe('.exe')
    expect(exts.indexOf('.exe')).toBeLessThan(exts.indexOf('.cmd'))
  })

  it('keeps the exact POSIX candidate list', () => {
    expect(binCandidates('linux', HOME, {})).toEqual([
      '/home/ada/.local/bin/claude',
      '/home/ada/.claude/local/claude',
      '/usr/local/bin/claude',
      '/opt/homebrew/bin/claude',
      '/usr/bin/claude',
      '/home/ada/.bun/bin/claude',
      '/home/ada/.volta/bin/claude'
    ])
    expect(binCandidates('darwin', HOME, {})).toEqual(binCandidates('linux', HOME, {}))
  })

  it('splits PATH on the platform separator', () => {
    // Splitting a Windows PATH on ':' shreds `C:\Program Files\...` into `C` and
    // `\Program Files\...`, so every probe misses and nothing says why.
    const seen: string[] = []
    resolveClaudePath('win32', { PATH: 'C:\\bin;D:\\tools' }, WINHOME, (p) => {
      seen.push(p)
      return false
    })
    expect(seen).toContain('C:\\bin\\claude.exe')
    expect(seen).toContain('D:\\tools\\claude.exe')
    expect(seen.some((p) => p.startsWith('C\\'))).toBe(false)
  })

  it('finds claude.exe on the Windows PATH', () => {
    const got = resolveClaudePath('win32', { PATH: 'C:\\bin' }, WINHOME, (p) => p === 'C:\\bin\\claude.exe')
    expect(got).toEqual({ path: 'C:\\bin\\claude.exe', needsShell: false })
  })

  it('flags a .cmd shim as needing a shell', () => {
    const got = resolveClaudePath(
      'win32',
      { PATH: 'C:\\bin', APPDATA: 'C:\\Users\\Ada\\AppData\\Roaming' },
      WINHOME,
      (p) => p === 'C:\\Users\\Ada\\AppData\\Roaming\\npm\\claude.cmd'
    )
    expect(got?.needsShell).toBe(true)
  })

  it('never asks for a shell on linux or darwin', () => {
    for (const platform of ['linux', 'darwin'] as const) {
      const got = resolveClaudePath(platform, { PATH: '/usr/bin' }, HOME, (p) => p === '/usr/bin/claude')
      expect(got).toEqual({ path: '/usr/bin/claude', needsShell: false })
    }
  })

  it('falls back to the install locations when PATH misses', () => {
    const got = resolveClaudePath('linux', { PATH: '/usr/bin' }, HOME, (p) => p === '/home/ada/.local/bin/claude')
    expect(got?.path).toBe('/home/ada/.local/bin/claude')
  })

  it('returns null rather than guessing', () => {
    expect(resolveClaudePath('linux', { PATH: '/usr/bin' }, HOME, () => false)).toBeNull()
  })
})

describe('mcp dataDir', () => {
  it('is unchanged on linux and darwin', () => {
    expect(dataDir('linux', HOME, {})).toBe('/home/ada/.config/clipboard.md/data')
    expect(dataDir('darwin', HOME, {})).toBe('/home/ada/Library/Application Support/clipboard.md/data')
  })

  it('uses %APPDATA% on Windows, matching app.getPath(userData)', () => {
    expect(dataDir('win32', WINHOME, { APPDATA: 'C:\\Users\\Ada\\AppData\\Roaming' })).toBe(
      'C:\\Users\\Ada\\AppData\\Roaming\\clipboard.md\\data'
    )
    // No APPDATA set (a stripped service environment) must still land in Roaming,
    // not in ~/.config, which nothing on Windows ever creates.
    expect(dataDir('win32', WINHOME, {})).toBe('C:\\Users\\Ada\\AppData\\Roaming\\clipboard.md\\data')
  })
})

describe('mcp copyCommand', () => {
  it('is unchanged on linux and darwin', () => {
    expect(copyCommand('darwin', {})).toEqual(['pbcopy'])
    expect(copyCommand('linux', { WAYLAND_DISPLAY: 'wayland-0' })).toEqual(['wl-copy'])
    expect(copyCommand('linux', {})).toEqual(['xclip', '-selection', 'clipboard', '-i'])
    expect(copyCommand('linux', { WAYLAND_DISPLAY: 'wayland-0', CLIPMD_FORCE_XCLIP: '1' })).toEqual([
      'xclip',
      '-selection',
      'clipboard',
      '-i'
    ])
  })

  it('uses Set-Clipboard on Windows instead of a tool that does not exist there', () => {
    expect(copyCommand('win32', {})[0]).toBe('powershell')
    expect(copyCommand('win32', {}).join(' ')).toContain('Set-Clipboard')
  })
})

describe('hooks.json generator', () => {
  /**
   * The scaffold file this generator replaced. If the generated POSIX command ever
   * stops matching it, a Linux install has silently changed the hook that runs at
   * the end of every turn of every Claude Code session on the machine.
   */
  const shipped = JSON.parse(
    readFileSync('resources/plugin/plugins/clipmd-bridge/hooks/hooks.json', 'utf8')
  )

  it('emits the shipped POSIX command verbatim on linux and darwin', () => {
    for (const platform of ['linux', 'darwin'] as const) {
      const generated = JSON.parse(hooksJson(platform, '/anything'))
      expect(generated.hooks.Stop[0].hooks[0].command).toBe(
        shipped.hooks.Stop[0].hooks[0].command
      )
      expect(generated.description).toBe(shipped.description)
    }
  })

  it('does not put the plugin directory into the POSIX command', () => {
    // Proof the darwin/linux output cannot vary by machine, the way the win32 one does.
    expect(hooksJson('linux', '/home/ada/x')).toBe(hooksJson('linux', '/opt/y'))
  })

  it('guards with cmd.exe syntax on Windows', () => {
    const cmd = JSON.parse(hooksJson('win32', 'C:\\Users\\Ada\\AppData\\Roaming\\clipboard.md\\plugin\\plugins\\clipmd-bridge'))
      .hooks.Stop[0].hooks[0].command as string
    // `[ -n "$VAR" ]` is not a weaker guard under cmd.exe — it is no guard at all:
    // `[` is not a command, cmd prints an error, and then runs the rest anyway on
    // every turn of every unrelated session on the machine.
    expect(cmd).not.toContain('[ -n')
    expect(cmd).toContain('if not "%CLIPMD_HOOK_NODE%"==""')
    expect(cmd).toContain('if not "%CLIPMD_SESSION_KEY%"==""')
    expect(cmd).toContain('mirror-turn.mjs')
    // Both env vars must be tested before the command runs, in either order.
    expect(cmd.indexOf('mirror-turn.mjs')).toBeGreaterThan(cmd.indexOf('%CLIPMD_SESSION_KEY%'))
  })
})
