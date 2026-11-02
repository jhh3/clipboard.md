import { app } from 'electron'
import { closeSync, mkdirSync, openSync, readdirSync, rmSync, statSync, write, writeSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

/**
 * File logging with redaction enforced at the transport, not at the call site.
 *
 * This app handles the user's passwords, tokens and private messages. Any logger
 * that relies on "remember not to log content" will eventually write a credential
 * to disk. So every line — no matter who wrote it — passes through the same
 * scrubber before it is written, and the log records clipboard *metadata* only.
 */

const MAX_FILES = 3
const MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000
const HOME = homedir()

const PATTERNS: Array<[RegExp, string]> = [
  // Key material and tokens, matching the capture-time secret patterns.
  [/\b(AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g, '[REDACTED_AWS_KEY]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[REDACTED_GH_TOKEN]'],
  [/\bsk-ant-[A-Za-z0-9_-]{10,}\b/g, '[REDACTED_ANTHROPIC_KEY]'],
  [/\bsk-[A-Za-z0-9_-]{20,}\b/g, '[REDACTED_OPENAI_KEY]'],
  [/\bAIza[0-9A-Za-z_-]{20,}/g, '[REDACTED_GOOGLE_KEY]'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED_SLACK_TOKEN]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, '[REDACTED_JWT]'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]'],
  // Credentials embedded in URLs and connection strings.
  [/\b(\w+:\/\/)[^\s:@/]+:[^\s:@/]+@/g, '$1[REDACTED_CREDS]@'],
  // Leading [\w.-]* so prefixed names match too: DB_PASSWORD, app.apiKey, MY-TOKEN.
  [
    /([\w.-]*(?:password|passwd|secret|api[_-]?key|token))(["']?\s*[:=]\s*["']?)[^\s"',}]+/gi,
    '$1$2[REDACTED]'
  ],
  // Contact details. Anchored to a non-path boundary and excluding '+' in the
  // local part, so pnpm store paths like `@openai+codex-sdk@1.2.3/node_modules`
  // aren't mangled into [REDACTED_EMAIL] inside every stack trace.
  [/(^|[\s"'<(,;:])([\w.-]+@[\w-]+\.[A-Za-z]{2,})\b/g, '$1[REDACTED_EMAIL]']
]

/** Scrub secrets and the user's home path from anything about to be written. */
export function redact(input: string): string {
  let out = input
  for (const [re, replacement] of PATTERNS) out = out.replace(re, replacement)
  // Home directory leaks the username into every stack trace.
  if (HOME.length > 1) out = out.split(HOME).join('~')
  return out
}

let logDir = ''

/**
 * Lines are batched and written off the main thread: each console call appends to
 * `pending`, and one async write per event-loop turn flushes the batch. This used to
 * be an appendFileSync (open, write, close) per line on the main thread, which a
 * key-repeat storm turned into tens of thousands of synchronous writes an hour.
 *
 * What is lost on a hard kill is at most the last turn's lines; every orderly exit
 * (quit, a fatal error, app.exit) flushes synchronously via flushLogSync.
 */
let pending = ''
let flushScheduled = false
let writing = false
let fd: number | null = null
let fdDay = ''

/** Local date, matching the Makefile's `date +%F` and the day the user lives in. */
function localDay(d = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function logFileFor(day: string): string {
  return join(logDir, `main-${day}.log`)
}

/** The fd for today's file, rolling over at midnight even in a multi-day run. */
function currentFd(): number | null {
  const day = localDay()
  if (fd !== null && day === fdDay) return fd
  try {
    if (fd !== null) closeSync(fd)
  } catch {
    /* already closed */
  }
  fd = null
  try {
    fd = openSync(logFileFor(day), 'a')
    fdDay = day
    rotate()
  } catch {
    /* logging must never throw */
  }
  return fd
}

function scheduleFlush(): void {
  if (flushScheduled) return
  flushScheduled = true
  setImmediate(flush)
}

function flush(): void {
  flushScheduled = false
  if (writing || !pending) return
  const f = currentFd()
  if (f === null) {
    pending = ''
    return
  }
  const data = pending
  pending = ''
  writing = true
  write(f, data, () => {
    writing = false
    if (pending) scheduleFlush()
  })
}

/** Write everything still buffered, synchronously. For exits. */
export function flushLogSync(): void {
  if (!pending) return
  const f = currentFd()
  const data = pending
  pending = ''
  if (f === null) return
  try {
    writeSync(f, data)
  } catch {
    /* never let logging throw */
  }
}

function rotate(): void {
  try {
    const files = readdirSync(logDir)
      .filter((f) => f.startsWith('main-') && f.endsWith('.log'))
      .sort()
    for (const f of files) {
      const full = join(logDir, f)
      const age = Date.now() - statSync(full).mtimeMs
      if (age > MAX_AGE_MS) rmSync(full, { force: true })
    }
    const remaining = readdirSync(logDir)
      .filter((f) => f.startsWith('main-') && f.endsWith('.log'))
      .sort()
    for (const f of remaining.slice(0, Math.max(0, remaining.length - MAX_FILES))) {
      rmSync(join(logDir, f), { force: true })
    }
  } catch {
    /* log hygiene must never break startup */
  }
}

/**
 * Route console.* through the redactor and into a daily file. Console output is
 * preserved so `pnpm dev` still shows everything.
 */
export function initLogging(): string {
  logDir = join(app.getPath('userData'), 'logs')
  mkdirSync(logDir, { recursive: true })
  rotate()
  // Captured BEFORE wrapping, so re-installation never wraps a wrapper.
  const originals = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console)
  }
  const file = logFileFor(localDay())
  // Whatever path the process takes out (app.exit included), the tail gets written.
  process.on('exit', flushLogSync)

  const wrap =
    (level: string, original: (...a: unknown[]) => void) =>
    (...args: unknown[]): void => {
      original(...args)
      try {
        const line = args
          .map((a) =>
            typeof a === 'string' ? a : a instanceof Error ? (a.stack ?? a.message) : safeJson(a)
          )
          .join(' ')
        pending += `${new Date().toISOString()} ${level} ${redact(line)}\n`
        scheduleFlush()
      } catch {
        /* never let logging throw */
      }
    }

  /**
   * Re-assert our wrappers periodically.
   *
   * Console is global and any dependency can replace it. Something in this app's
   * tree does exactly that a few seconds after launch: startup lines are recorded
   * and then logging goes silent for the rest of the process's life, which cost
   * hours of debugging against logs that looked like "the code never ran" when the
   * code had run fine. Re-installing is cheap and makes the log trustworthy.
   */
  const install = (): void => {
    if ((console.log as MaybeOurs).__clipmd !== true) {
      console.log = tag(wrap('INFO', originals.log))
      console.warn = tag(wrap('WARN', originals.warn))
      console.error = tag(wrap('ERROR', originals.error))
    }
  }
  install()
  // Unref'd so it never keeps the process alive on quit.
  setInterval(install, 5000).unref()
  return file
}

interface MaybeOurs {
  __clipmd?: boolean
}

/** Mark a wrapper as ours, so re-installation can tell it from a hijacker's. */
function tag<T extends (...a: never[]) => void>(fn: T): T {
  ;(fn as unknown as MaybeOurs).__clipmd = true
  return fn
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export function closeLogging(): void {
  flushLogSync()
}

/**
 * Clipboard events are logged as metadata only — never content. Knowing that a
 * 4KB text clip arrived from Firefox is enough to debug capture; the bytes are not.
 */
export function logClipEvent(meta: {
  kind: string
  bytes: number
  sourceApp?: string
  secret: boolean
  stored: boolean
}): void {
  console.log(
    `[capture] ${meta.stored ? 'stored' : 'skipped'} kind=${meta.kind} bytes=${meta.bytes} ` +
      `app=${meta.sourceApp ?? 'unknown'}${meta.secret ? ' secret=1' : ''}`
  )
}
