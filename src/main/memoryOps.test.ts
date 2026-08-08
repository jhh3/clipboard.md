import { describe, expect, it } from 'vitest'
import { applyOps, validateMemory, recentEntryCount, SECTION_NAMES } from './memoryOps'

const FILE = [
  '## About the user',
  '- 2026-08-01: John is a software engineer.',
  '',
  '## Preferences',
  '- 2026-08-02: Prefers terse answers.',
  '',
  '## Current projects',
  '',
  '## Assistant lessons',
  '',
  '## Recent (unconsolidated)',
  '- 2026-08-07: Uses pnpm, not npm.',
  ''
].join('\n')

describe('applyOps', () => {
  it('updates the addressed line in place', () => {
    const next = applyOps(FILE, [
      { op: 'update', line: 5, text: '- 2026-08-08: Prefers terse answers; no emojis.' }
    ])
    expect(next).toContain('no emojis')
    expect(next).not.toContain('- 2026-08-02: Prefers terse answers.')
  })

  it('folds a Recent entry into its section: delete + add', () => {
    const next = applyOps(FILE, [
      { op: 'delete', line: 12 },
      { op: 'add', section: 'Preferences', text: '- 2026-08-08: Uses pnpm, not npm.' }
    ])
    const recentIdx = next.indexOf('## Recent')
    expect(next.slice(recentIdx)).not.toContain('pnpm')
    const prefIdx = next.indexOf('## Preferences')
    const projIdx = next.indexOf('## Current projects')
    expect(next.slice(prefIdx, projIdx)).toContain('pnpm')
  })

  it('applies deletes bottom-up so numbering does not shift', () => {
    const next = applyOps(FILE, [
      { op: 'delete', line: 2 },
      { op: 'delete', line: 12 }
    ])
    expect(next).not.toContain('software engineer')
    expect(next).not.toContain('pnpm')
    expect(next).toContain('Prefers terse answers')
  })

  it('adds to Recent when the section is unknown', () => {
    const next = applyOps(FILE, [{ op: 'add', section: 'Nonexistent', text: '- 2026-08-08: X.' }])
    expect(next.slice(next.indexOf('## Recent'))).toContain('- 2026-08-08: X.')
  })

  it('normalizes a missing bullet prefix', () => {
    const next = applyOps(FILE, [{ op: 'add', section: 'Preferences', text: '2026-08-08: Y.' }])
    expect(next).toContain('- 2026-08-08: Y.')
  })

  it('rejects an op that targets a section header', () => {
    expect(() => applyOps(FILE, [{ op: 'delete', line: 4 }])).toThrow(/header/)
  })

  it('rejects two ops addressing the same line', () => {
    expect(() =>
      applyOps(FILE, [
        { op: 'delete', line: 5 },
        { op: 'update', line: 5, text: '- 2026-08-08: Z.' }
      ])
    ).toThrow(/two ops target/)
  })

  it('rejects out-of-range and malformed ops', () => {
    expect(() => applyOps(FILE, [{ op: 'delete', line: 999 }])).toThrow(/out of range/)
    expect(() => applyOps(FILE, [{ op: 'update', line: 2 }])).toThrow(/without text/)
    expect(() => applyOps(FILE, [{ op: 'add', section: 'Preferences' }])).toThrow(/without text/)
  })
})

describe('validateMemory', () => {
  it('accepts a normal reconciliation', () => {
    const ops = [{ op: 'delete', line: 12 } as const]
    const next = applyOps(FILE, [...ops])
    expect(validateMemory(next, FILE, [...ops])).toBeNull()
  })

  it('rejects a result that lost a section', () => {
    const broken = FILE.replace('## Assistant lessons', '## Lessons')
    expect(validateMemory(broken, FILE, [])).toMatch(/went missing/)
  })

  it('rejects shrinkage its deletes do not account for', () => {
    // All sections intact, but every fact line vanished with zero delete ops.
    const stripped = FILE.split('\n')
      .filter((l) => !l.startsWith('- '))
      .join('\n')
    expect(validateMemory(stripped, FILE, [])).toMatch(/shrank/)
  })

  it('rejects an empty result and a mass delete', () => {
    expect(validateMemory('', FILE, [])).toMatch(/empty/)
    const many = Array.from({ length: 16 }, (_, i) => ({ op: 'delete' as const, line: i + 1 }))
    expect(validateMemory(FILE, FILE, many)).toMatch(/deletes in one pass/)
  })
})

describe('recentEntryCount', () => {
  it('counts only entries under the Recent header', () => {
    expect(recentEntryCount(FILE)).toBe(1)
    expect(recentEntryCount(FILE.replace('## Recent (unconsolidated)', '## Renamed'))).toBe(0)
  })

  it('section list keeps Recent last so blind appends stay in-section', () => {
    expect(SECTION_NAMES[SECTION_NAMES.length - 1]).toBe('Recent (unconsolidated)')
  })
})
