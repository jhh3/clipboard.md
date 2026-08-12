import { describe, it, expect } from 'vitest'
import { parseWatchLine, watcherCommand } from './sequenceWatcher'
import { decodeWide, exeBasename } from './user32'

/**
 * The sidecar's line protocol, tested against the shapes PowerShell actually emits.
 *
 * The tolerance is the point. PowerShell can put a banner, a warning about an
 * unsigned profile, or a progress record on stdout before our first line, and a
 * strict parser would read one of those as a clipboard event with sequence NaN —
 * which primes the watcher on garbage and then never fires again.
 */
describe('parseWatchLine', () => {
  it('reads a plain event', () => {
    expect(parseWatchLine('CLIP 41823 0 0 0')).toEqual({ sequence: 41823, concealed: false })
  })

  it('treats any one concealed marker as concealed', () => {
    // No application sets all three: ExcludeClipboardContentFromMonitorProcessing is
    // what third-party managers have honoured for years, the other two are what
    // Windows' own clipboard history reads. Any of them means the same to us.
    expect(parseWatchLine('CLIP 2 1 0 0')?.concealed).toBe(true)
    expect(parseWatchLine('CLIP 2 0 1 0')?.concealed).toBe(true)
    expect(parseWatchLine('CLIP 2 0 0 1')?.concealed).toBe(true)
  })

  it('tolerates CR and extra whitespace', () => {
    // The pipe carries CRLF on Windows; splitting on \n leaves the \r behind.
    expect(parseWatchLine('CLIP 7 0 0 0\r')).toEqual({ sequence: 7, concealed: false })
    expect(parseWatchLine('  CLIP   7  0 0 0 ')).toEqual({ sequence: 7, concealed: false })
  })

  it('ignores anything that is not our line', () => {
    for (const junk of [
      '',
      'WARNING: something',
      'CLIP',
      'CLIP notanumber 0 0 0',
      'CLIP 5 0 0', // truncated write
      'At line:1 char:1'
    ]) {
      expect(parseWatchLine(junk), junk).toBeNull()
    }
  })
})

describe('watcherCommand', () => {
  const { cmd, args } = watcherCommand('C:\\app\\resources\\win\\clipwatch.ps1')

  it('uses Windows PowerShell, which is the one that is always installed', () => {
    // pwsh (PowerShell 7) is not present on a stock Windows and the script needs
    // nothing newer than 5.1.
    expect(cmd).toBe('powershell.exe')
  })

  it('bypasses the execution policy and the user profile', () => {
    // The default policy blocks unsigned local scripts outright, and a profile can
    // print a banner straight into our line protocol.
    expect(args).toContain('-ExecutionPolicy')
    expect(args).toContain('Bypass')
    expect(args).toContain('-NoProfile')
    expect(args).toContain('-NonInteractive')
    expect(args[args.length - 2]).toBe('-File')
    expect(args[args.length - 1]).toBe('C:\\app\\resources\\win\\clipwatch.ps1')
  })
})

describe('exeBasename', () => {
  it('lowercases, because the ignore list is matched as a substring', () => {
    expect(exeBasename('C:\\Program Files\\1Password\\1Password.exe')).toBe('1password.exe')
  })

  it('matches the shipped ignore-list entries', async () => {
    // The defence is only real if the name we produce contains the needle the user
    // has in their list. `1password` must match `1password.exe` — if it did not, the
    // shipped default would be decoration.
    const { DEFAULT_SETTINGS } = await import('@shared/types')
    const exe = exeBasename('C:\\Program Files\\1Password\\1Password.exe')
    expect(DEFAULT_SETTINGS.ignoreApps.some((a) => exe.includes(a.toLowerCase()))).toBe(true)
    for (const [path, needle] of [
      ['C:\\Program Files\\KeePassXC\\KeePassXC.exe', 'keepassxc'],
      ['C:\\Users\\Ada\\AppData\\Local\\Programs\\Bitwarden\\Bitwarden.exe', 'bitwarden'],
      ['C:\\Program Files\\Dashlane\\Dashlane.exe', 'dashlane']
    ] as const) {
      expect(exeBasename(path)).toContain(needle)
      expect(DEFAULT_SETTINGS.ignoreApps).toContain(needle)
    }
  })

  it('survives a forward-slash path', () => {
    expect(exeBasename('C:/tools/Foo.EXE')).toBe('foo.exe')
  })
})

describe('decodeWide', () => {
  it('stops at the NUL, not at the end of the buffer', () => {
    // QueryFullProcessImageNameW writes into a 520-wchar buffer; taking the whole
    // buffer would append 500 NULs to every process name.
    const buf = new Uint16Array(16)
    for (const [i, c] of Array.from('a.exe').entries()) buf[i] = c.charCodeAt(0)
    expect(decodeWide(buf)).toBe('a.exe')
  })

  it('handles a buffer with no NUL at all', () => {
    expect(decodeWide(Uint16Array.from([104, 105]))).toBe('hi')
  })
})
