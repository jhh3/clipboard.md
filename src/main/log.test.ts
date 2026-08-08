import { describe, it, expect } from 'vitest'
import { redact } from './log'

/**
 * The redactor is the last line of defence before user content reaches disk.
 * If any of these regress, a real credential ends up in a log file.
 */
describe('log redaction', () => {
  const cases: Array<[string, string, string]> = [
    ['aws key', 'using AKIAIOSFODNN7EXAMPLE now', 'AKIAIOSFODNN7EXAMPLE'],
    ['github token', 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij', 'ghp_ABCDEFGHIJKLMNOPQRST'],
    ['openai key', 'sk-abcdefghijklmnopqrstuvwxyz1234567890', 'sk-abcdefghijklmnopqrst'],
    ['anthropic key', 'sk-ant-api03-abcdefghijklmnop', 'sk-ant-api03'],
    ['google key', 'AIzaSyA1234567890abcdefghijklmnopqrstuvw', 'AIzaSyA1234567890'],
    ['slack token', 'xoxb-123456789012-1234567890123-abcdef', 'xoxb-123456789012'],
    [
      'jwt',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N',
      'eyJzdWIiOiIxMjM0NTY3ODkw'
    ],
    ['connection string', 'postgres://admin:hunter2@db.example.com/app', 'hunter2'],
    ['assignment', 'DB_PASSWORD=supersecretvalue', 'supersecretvalue'],
    ['email', 'contact john@nullframe.ai about it', 'john@nullframe.ai']
  ]

  for (const [name, input, mustNotAppear] of cases) {
    it(`removes ${name}`, () => {
      expect(redact(input)).not.toContain(mustNotAppear)
    })
  }

  it('redacts a private key block entirely', () => {
    const key = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----'
    const out = redact(`failed with ${key}`)
    expect(out).not.toContain('MIIEowIBAAKCAQEA')
    expect(out).toContain('[REDACTED_PRIVATE_KEY]')
  })

  it('replaces the home directory so logs do not leak the username', () => {
    const out = redact(`ENOENT at ${process.env.HOME}/.config/clipboard.md/data`)
    expect(out).not.toContain(`${process.env.HOME}/.config`)
    expect(out).toContain('~/.config')
  })

  it('does not mangle pnpm paths that contain @', () => {
    const path = '/home/u/app/node_modules/.pnpm/@openai+codex-sdk@1.2.3/dist/index.js'
    expect(redact(path)).toContain('@openai+codex-sdk')
  })

  it('leaves ordinary diagnostics readable', () => {
    const msg = '[capture] stored kind=text bytes=412 app=firefox'
    expect(redact(msg)).toBe(msg)
  })
})
