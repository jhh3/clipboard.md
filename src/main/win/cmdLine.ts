/**
 * Building a cmd.exe command line by hand, because `{ shell: true }` does not.
 *
 * Node's shell option looks like it quotes for you. It does not: with `shell: true`
 * it runs `[file, ...args].join(' ')` and hands the result to
 * `cmd.exe /d /s /c "<that>"` with windowsVerbatimArguments — no per-argument
 * quoting anywhere. Every space splits an argument in two, and every cmd
 * metacharacter is live. Demonstrated on the shared code path:
 * `execFileSync('echo', ['hello && echo INJECTED'], { shell: true })` prints
 * "hello" and then "INJECTED".
 *
 * That matters here because the shell is not optional. A `claude.cmd` from an
 * npm-global install is a supported resolution (binCandidates probes
 * `%APPDATA%\npm\claude.cmd`), Node ≥18.20 refuses to spawn a batch file without a
 * shell, and the arguments we pass are `--append-system-prompt <prose>` and an
 * opening prompt built from CLIPBOARD CONTENT — page text, OCR output, window
 * titles. Nobody has to be malicious for `&`, `|`, `>` or a pair of quotes to end up
 * in there; they arrive by copying a shell command out of a README.
 *
 * So we build the line ourselves, quote every argument, and pass it verbatim. `/s`
 * is what makes the outer pair of quotes strippable: with it cmd removes exactly the
 * first and last quote of the tail and executes the rest, so each argument's own
 * quoting survives intact. Inside double quotes cmd treats `& | < > ^ ( )` as
 * ordinary characters, which is the property the whole scheme rests on.
 */

/**
 * Quote one argument so that BOTH parsers downstream see it whole.
 *
 * Two parsers, not one: cmd.exe first (which only respects double quotes), then the
 * target program's own CommandLineToArgvW (which respects the backslash-before-quote
 * rules). The doubling of backslashes below is the second parser's rule — `a\"b` has
 * to arrive as `a\\\"b` or the quote is read as a delimiter.
 *
 * Always quoted, even when there is nothing to escape: an unquoted argument is one
 * copied `&&` away from being a second command, and a uniform rule is a rule that
 * can be read.
 */
export function quoteForCmd(arg: string): string {
  let out = '"'
  let backslashes = 0
  for (const ch of arg) {
    if (ch === '\\') {
      backslashes++
      continue
    }
    if (ch === '"') {
      // Backslashes before a quote are doubled, then the quote itself is escaped.
      out += '\\'.repeat(backslashes * 2 + 1) + '"'
      backslashes = 0
      continue
    }
    out += '\\'.repeat(backslashes) + ch
    backslashes = 0
  }
  // Trailing backslashes are doubled so they do not escape our closing quote.
  return out + '\\'.repeat(backslashes * 2) + '"'
}

/**
 * True for text cmd.exe cannot carry on a command line at all.
 *
 * A line feed is a command separator to cmd, and no amount of quoting escapes one —
 * the tail after it becomes a SECOND command. There is no correct encoding to fall
 * back to, so callers must refuse instead of shipping a truncated prompt and a
 * mystery command. (This is not a regression: `shell: true` had the same hole, with
 * no quoting in front of it.)
 */
export function hasUnquotableNewline(arg: string): boolean {
  return /[\r\n]/.test(arg)
}

export interface CmdInvocation {
  file: string
  args: string[]
  options: { windowsVerbatimArguments: true }
}

/**
 * `cmd.exe /d /s /c "<program> <args…>"`, every part quoted.
 *
 * /d skips AutoRun commands from the registry — a per-machine hook that would
 * otherwise run before ours. windowsVerbatimArguments because we have already done
 * the quoting and Node must not do it again.
 *
 * Throws on an argument containing a newline rather than passing it: see
 * hasUnquotableNewline. The one residual limitation, which cmd's command-line mode
 * has no escape for, is `%VAR%`: a defined variable is still expanded inside quotes.
 * That can leak an environment value into a prompt; it cannot start a command, which
 * is the property that matters.
 */
export function cmdInvocation(
  program: string,
  args: string[],
  comspec: string | undefined = process.env.ComSpec
): CmdInvocation {
  for (const arg of args) {
    if (hasUnquotableNewline(arg)) {
      throw new Error(
        'cannot pass a multi-line argument through a .cmd shim: cmd.exe treats a ' +
          'newline as a command separator. Install the native claude.exe (the ' +
          'official installer, or winget) so no shell is needed.'
      )
    }
  }
  const line = [program, ...args].map(quoteForCmd).join(' ')
  return {
    file: comspec ?? 'cmd.exe',
    args: ['/d', '/s', '/c', `"${line}"`],
    options: { windowsVerbatimArguments: true }
  }
}
