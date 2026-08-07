import { app } from 'electron'
import { createWriteStream, mkdirSync, readdirSync, rmSync, statSync, type WriteStream } from 'fs'
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
  // Contact details.
  [/\b[\w.+-]+@[\w-]+\.[\w.]{2,}\b/g, '[REDACTED_EMAIL]']
]

/** Scrub secrets and the user's home path from anything about to be written. */
export function redact(input: string): string {
  let out = input
  for (const [re, replacement] of PATTERNS) out = out.replace(re, replacement)
  // Home directory leaks the username into every stack trace.
  if (HOME.length > 1) out = out.split(HOME).join('~')
  return out
}

let stream: WriteStream | null = null
let logDir = ''

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
  const day = new Date().toISOString().slice(0, 10)
  const file = join(logDir, `main-${day}.log`)
  stream = createWriteStream(file, { flags: 'a' })

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
        stream?.write(`${new Date().toISOString()} ${level} ${redact(line)}\n`)
      } catch {
        /* never let logging throw */
      }
    }

  console.log = wrap('INFO', console.log.bind(console))
  console.warn = wrap('WARN', console.warn.bind(console))
  console.error = wrap('ERROR', console.error.bind(console))
  return file
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export function closeLogging(): void {
  stream?.end()
  stream = null
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
