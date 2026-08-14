import { describe, it, expect } from 'vitest'
import { cmdInvocation, hasUnquotableNewline, quoteForCmd } from './cmdLine'
import { claudeInvocationFor } from '../claudeBin'

/**
 * What `{ shell: true }` did, and what we do instead.
 *
 * The arguments on this path are `--append-system-prompt <prose>` and an opening
 * prompt assembled from CLIPBOARD CONTENT. Node's shell option joins them with
 * spaces and quotes nothing, so a copied README line was cmd syntax. These tests are
 * the substitute for a Windows box: they check the exact string handed to cmd.exe.
 */

/** How cmd.exe splits a `/d /s /c "…"` tail: strip the outer pair, then respect quotes. */
/**
 * What the PROGRAM finally receives: cmd consumes the carets, then the CRT parses
 * backslashes and quotes. Two parsers in series, so the test models both.
 */
function stripCarets(line: string): string {
  let out = ''
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '^') { i++; if (i < line.length) out += line[i]; continue }
    out += line[i]
  }
  return out
}

function cmdWouldSee(invocation: { args: string[] }): string[] {
  const tail = invocation.args[3]
  expect(tail.startsWith('"') && tail.endsWith('"')).toBe(true)
  // cmd consumes the carets before the program's CRT ever sees the line.
  const inner = stripCarets(tail.slice(1, -1))
  const out: string[] = []
  let cur = ''
  let inQuotes = false
  let backslashes = 0
  let started = false
  for (const ch of inner) {
    if (ch === '\\') {
      backslashes++
      continue
    }
    if (ch === '"') {
      cur += '\\'.repeat(Math.floor(backslashes / 2))
      if (backslashes % 2 === 1) cur += '"'
      else inQuotes = !inQuotes
      backslashes = 0
      started = true
      continue
    }
    cur += '\\'.repeat(backslashes)
    backslashes = 0
    if (ch === ' ' && !inQuotes) {
      if (started) out.push(cur)
      cur = ''
      started = false
      continue
    }
    cur += ch
    started = true
  }
  cur += '\\'.repeat(backslashes)
  if (started || cur) out.push(cur)
  return out
}

/**
 * What CMD ITSELF would act on. Deliberately models cmd's parser, not the CRT's: cmd
 * has no backslash escape, only the caret, and it decides whether a metacharacter is
 * live by counting double quotes. The original helper modelled the CRT here, so it
 * agreed with the very bug it was meant to catch — the injection assertion passed
 * while cmd would have run a second command.
 */
function cmdLiveMetachar(invocation: { args: string[] }): boolean {
  const inner = invocation.args[3].replace(/^"/, '').replace(/"$/, '')
  let quoted = false
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]
    if (ch === '^') { i++; continue }
    if (ch === '"') { quoted = !quoted; continue }
    if (!quoted && '&|<>'.includes(ch)) return true
  }
  return false
}



describe('quoteForCmd', () => {
  it('keeps an argument with spaces whole', () => {
    expect(quoteForCmd('two words')).toBe('"two words"')
  })

  it('defuses the cmd metacharacters that made a prompt into a command', () => {
    // `execFileSync('echo', ['hello && echo INJECTED'], {shell:true})` really does
    // print INJECTED. Inside double quotes cmd treats these as ordinary text.
    for (const meta of ['&&', '&', '|', '>', '<', '^', '(', ')']) {
      expect(quoteForCmd(`hello ${meta} world`)).toBe(`"hello ${meta} world"`)
    }
  })

  it('escapes quotes so they cannot close the argument early', () => {
    expect(quoteForCmd('say "hi"')).toBe('"say \\"hi\\""')
  })

  it('doubles backslashes that would otherwise escape our closing quote', () => {
    // A Windows path argument ends in a backslash more often than anything else:
    // `C:\Users\Ada\` must not become `C:\Users\Ada"` to the next parser.
    expect(quoteForCmd('C:\\Users\\Ada\\')).toBe('"C:\\Users\\Ada\\\\"')
    // Interior backslashes are literal and stay single.
    expect(quoteForCmd('C:\\Users\\Ada')).toBe('"C:\\Users\\Ada"')
  })
})

describe('cmdInvocation', () => {
  const shim = 'C:\\Users\\Ada Lovelace\\AppData\\Roaming\\npm\\claude.cmd'

  it('round-trips every argument through cmd’s own splitting', () => {
    const args = [
      '--dangerously-load-development-channels',
      'plugin:clipmd-bridge@clipboard-md',
      '--add-dir',
      'C:\\Users\\Ada Lovelace\\Documents\\My Project',
      '--append-system-prompt',
      'You are Ada. Use "sensible" defaults & never ask twice.',
      'summarise this: rm -rf / && echo pwned | tee out.txt'
    ]
    const inv = cmdInvocation(shim, args, 'C:\\Windows\\system32\\cmd.exe')
    expect(inv.file).toBe('C:\\Windows\\system32\\cmd.exe')
    expect(inv.args.slice(0, 3)).toEqual(['/d', '/s', '/c'])
    expect(inv.options).toEqual({ windowsVerbatimArguments: true })
    // The whole point: claude sees exactly the arguments we passed, no more.
    expect(cmdWouldSee(inv)).toEqual([shim, ...args])
  })

  it('refuses a multi-line argument instead of running its second line', () => {
    // cmd has no escape for a newline on a command line — the tail after it is a
    // separate command. Silently truncating a prompt is not an option either.
    expect(() => cmdInvocation(shim, ['--append-system-prompt', 'line one\nline two'])).toThrow(
      /multi-line/
    )
    expect(hasUnquotableNewline('a\r\nb')).toBe(true)
    expect(hasUnquotableNewline('a b')).toBe(false)
  })

  it('falls back to cmd.exe when ComSpec is unset', () => {
    // Actually unset it. Passing undefined only bypasses the ARGUMENT; the fallback
    // reads process.env.ComSpec, which is set on a real Windows runner — so this
    // asserted the fallback while never reaching it, and passed only on Linux.
    const saved = process.env.ComSpec
    delete process.env.ComSpec
    try {
      expect(cmdInvocation(shim, [], undefined).file).toBe('cmd.exe')
    } finally {
      if (saved !== undefined) process.env.ComSpec = saved
    }
  })

  it('prefers ComSpec when the environment provides one', () => {
    const saved = process.env.ComSpec
    process.env.ComSpec = 'C:\\Windows\\system32\\cmd.exe'
    try {
      expect(cmdInvocation(shim, [], undefined).file).toBe('C:\\Windows\\system32\\cmd.exe')
    } finally {
      if (saved === undefined) delete process.env.ComSpec
      else process.env.ComSpec = saved
    }
  })
})

describe('claudeInvocationFor', () => {
  it('is a pass-through for a real binary, on every platform', () => {
    // The Linux and macOS spawns must be byte-for-byte the ones that shipped: same
    // file, the same args array, and no options at all.
    const args = ['--append-system-prompt', 'be brief', 'hello world']
    for (const path of ['/usr/local/bin/claude', 'C:\\Program Files\\claude\\claude.exe']) {
      expect(claudeInvocationFor({ path, needsShell: false }, args)).toEqual({
        file: path,
        args,
        options: {}
      })
    }
  })

  it('still falls back to the bare name when nothing was resolved', () => {
    expect(claudeInvocationFor(null, ['--version'])).toEqual({
      file: 'claude',
      args: ['--version'],
      options: {}
    })
  })

  it('wraps only the .cmd shim', () => {
    const inv = claudeInvocationFor(
      { path: 'C:\\npm\\claude.cmd', needsShell: true },
      ['plugin', 'marketplace', 'add', 'C:\\Users\\Ada Lovelace\\AppData\\Roaming\\clipboard.md\\plugin'],
      'cmd.exe'
    )
    expect(inv.file).toBe('cmd.exe')
    expect(cmdWouldSee(inv)).toEqual([
      'C:\\npm\\claude.cmd',
      'plugin',
      'marketplace',
      'add',
      'C:\\Users\\Ada Lovelace\\AppData\\Roaming\\clipboard.md\\plugin'
    ])
  })
})

describe('cmd.exe metacharacter injection', () => {
  // Clipboard text is attacker-influenced: you copy a snippet from a web page and
  // then ask an agent about it. Each of these left a LIVE metacharacter before the
  // caret pass, because cmd counts quotes and an odd count put it out-of-quote —
  // the first one ran `calc.exe` as a second command.
  const payloads = [
    `summarise: Ada's 24" monitor & calc.exe`,
    `run: git commit -m "wip && echo PWNED`,
    `he said "hi | tee C:\\pwned.txt`,
    `the "big file > C:\\Users\\Ada\\pwned`,
    `a "b" c & d`,
    `plain text with, a comma and (parens)`
  ]
  for (const payload of payloads) {
    it(`leaves nothing live for cmd: ${payload.slice(0, 30)}`, () => {
      const inv = cmdInvocation('C:\\Users\\Ada\\claude.cmd', ['-p', payload], 'cmd.exe')
      expect(cmdLiveMetachar(inv)).toBe(false)
      // and the program still receives the argument intact
      expect(cmdWouldSee(inv)).toEqual(['C:\\Users\\Ada\\claude.cmd', '-p', payload])
    })
  }
})
