import { describe, it, expect } from 'vitest'
import { detectSecret, hasConcealedFormat, runFilters } from './filters'

/**
 * The filter chain is the app's privacy boundary: anything it misses gets stored,
 * full-text indexed, embedded, and offered to AI providers. Both directions matter —
 * a false negative leaks a credential, a false positive silently makes an ordinary
 * clip unsearchable and un-enrichable.
 */
describe('detectSecret — must catch', () => {
  const positives: Array<[string, string]> = [
    ['aws access key', 'AKIAIOSFODNN7EXAMPLE'],
    ['aws temp key', 'ASIAIOSFODNN7EXAMPLE'],
    ['private key block', '-----BEGIN RSA PRIVATE KEY-----\nMIIEow...'],
    ['openssh private key', '-----BEGIN OPENSSH PRIVATE KEY-----\nb3Blbn...'],
    [
      'jwt',
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'
    ],
    ['github token', 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij'],
    ['openai key', 'sk-abcdefghijklmnopqrstuvwxyz1234567890ABCD'],
    ['anthropic key', 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234'],
    ['google api key', 'AIzaSyA1234567890abcdefghijklmnopqrstuvw'],
    ['slack token', 'xoxb-123456789012-1234567890123-abcdefghijklmnop'],
    ['stripe live key', 'sk_live_abcdefghijklmnopqrstuvwx'],
    ['password assignment', 'DB_PASSWORD=hunter2-correct-horse'],
    ['api key assignment', 'api_key: "abcdefghijklmnopqrst"'],
    ['connection string with creds', 'postgres://admin:s3cr3tpassword@db.internal:5432/app']
  ]
  for (const [name, sample] of positives) {
    it(name, () => expect(detectSecret(sample)).not.toBeNull())
  }
})

describe('detectSecret — must NOT flag', () => {
  const negatives: Array<[string, string]> = [
    ['ordinary prose', 'Remember to email the team about the release on Friday.'],
    ['a url', 'https://github.com/jhh3/clipboard.md/blob/main/README.md'],
    ['a git sha', 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0'],
    ['a uuid', '3f2504e0-4f89-11d3-9a0c-0305e82c3301'],
    ['a file path', '/home/jhh3/code/personal/clipboard.md/src/main/capture/filters.ts'],
    ['a code snippet', 'const total = items.reduce((a, b) => a + b.count, 0)'],
    ['a short token-ish word', 'kubernetes-autoscaler'],
    ['a phone number', '+1 (415) 555-0134'],
    ['sql', 'SELECT id, preview FROM items WHERE pinned = 1 ORDER BY last_copied_at DESC']
  ]
  for (const [name, sample] of negatives) {
    it(name, () => expect(detectSecret(sample)).toBeNull())
  }
})

describe('hasConcealedFormat', () => {
  it('honours the macOS concealed type', () => {
    expect(hasConcealedFormat(['public.utf8-plain-text', 'org.nspasteboard.ConcealedType'])).toBe(true)
  })
  it('honours the KDE password hint', () => {
    expect(hasConcealedFormat(['text/plain', 'x-kde-passwordManagerHint'])).toBe(true)
  })
  it('is case-insensitive', () => {
    expect(hasConcealedFormat(['ORG.NSPASTEBOARD.CONCEALEDTYPE'])).toBe(true)
  })
  it('ignores ordinary formats', () => {
    expect(hasConcealedFormat(['text/plain', 'text/html', 'image/png'])).toBe(false)
  })
})

describe('runFilters', () => {
  const base = { formats: ['text/plain'], ignoreApps: ['1password', 'keepassxc'] }

  it('stores ordinary text', () => {
    expect(runFilters({ ...base, text: 'hello team' }).verdict).toBe('store')
  })

  it('flags (but keeps) secrets so they are masked and never indexed', () => {
    const r = runFilters({ ...base, text: 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij' })
    expect(r.verdict).toBe('store-secret')
  })

  it('skips concealed clipboard payloads outright', () => {
    const r = runFilters({
      ...base,
      text: 'hunter2',
      formats: ['text/plain', 'org.nspasteboard.ConcealedType']
    })
    expect(r.verdict).toBe('skip')
  })

  it('skips copies from ignored apps — the ignore list must actually work', () => {
    // Regression guard: sourceApp was never populated, so this shipped inert.
    const r = runFilters({ ...base, text: 'whatever', sourceApp: 'org.keepassxc.KeePassXC' })
    expect(r.verdict).toBe('skip')
    expect(r.reason).toContain('ignored-app')
  })

  it('matches ignored apps case-insensitively and by substring', () => {
    expect(runFilters({ ...base, text: 'x', sourceApp: '1Password' }).verdict).toBe('skip')
  })

  it('does not skip when the source app is unknown', () => {
    expect(runFilters({ ...base, text: 'x', sourceApp: undefined }).verdict).toBe('store')
  })

  it('matches an ignored app by macOS bundle id when the display name does not', () => {
    // 1Password's browser helper is named "1Password Extension Helper" in some
    // builds and localized in others, but the bundle id is stable. Without this the
    // ignore list silently misses exactly the app it exists for.
    const r = runFilters({
      ...base,
      text: 'x',
      sourceApp: 'Extension Helper',
      sourceAppId: 'com.1password.1password-launcher'
    })
    expect(r.verdict).toBe('skip')
    expect(r.reason).toContain('ignored-app')
  })

  it('does not skip when neither the name nor the bundle id is ignored', () => {
    const r = runFilters({
      ...base,
      text: 'x',
      sourceApp: 'Safari',
      sourceAppId: 'com.apple.Safari'
    })
    expect(r.verdict).toBe('store')
  })

  it('still applies the ignore list when only a bundle id is known', () => {
    expect(
      runFilters({ ...base, text: 'x', sourceAppId: 'org.keepassxc.KeePassXC' }).verdict
    ).toBe('skip')
  })

  it('skips empty text', () => {
    expect(runFilters({ ...base, text: '   ' }).verdict).toBe('skip')
  })
})
