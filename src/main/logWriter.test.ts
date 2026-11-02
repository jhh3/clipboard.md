import { describe, it, expect, vi, afterAll } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const dir = mkdtempSync(join(tmpdir(), 'clipmd-log-'))
vi.mock('electron', () => ({ app: { getPath: () => dir } }))

describe('log writer', () => {
  const restore = { log: console.log, warn: console.warn, error: console.error }
  afterAll(() => {
    Object.assign(console, restore)
    rmSync(dir, { recursive: true, force: true })
  })

  it('batches lines off the call path and flushes them, redacted, to the daily file', async () => {
    const { initLogging, flushLogSync } = await import('./log')
    const file = initLogging()
    console.log('[test] first line')
    console.log('[test] key sk-abcdefghijklmnopqrstuvwxyz123456')
    // Nothing written synchronously: the write happens on a later turn.
    const before = readdirSync(join(dir, 'logs')).length ? readFileSync(file, 'utf8') : ''
    expect(before).not.toContain('[test] first line')
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setTimeout(r, 20))
    flushLogSync()
    const text = readFileSync(file, 'utf8')
    expect(text).toContain('[test] first line')
    expect(text).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456')
    expect(text.indexOf('first line')).toBeLessThan(text.indexOf('[test] key'))
  })
})
