import { afterAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const dir = mkdtempSync(join(tmpdir(), 'clipmd-settings-'))
vi.mock('electron', () => ({ app: { getPath: () => dir } }))
const { getSettings, _resetSettingsCache } = await import('./settings')

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('provider settings migration', () => {
  it('drops retired lanes, per-feature providers and dead model ids', () => {
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({
        enrichment: { enabled: false, lane: 'subscription', provider: 'claude-agent' },
        transforms: { provider: 'gemini' },
        models: {
          'claude-agent': 'haiku',
          openai: 'gpt-5.6-luna',
          fireworks: 'accounts/fireworks/models/deepseek-v4-flash-0731',
          gemini: 'gemini-flash-lite-latest'
        },
        savedActions: [{ id: 'mine', title: 'Mine', type: 'prompt', prompt: 'x', appliesTo: ['text'], provider: 'codex' }]
      })
    )
    _resetSettingsCache()
    const s = getSettings()
    expect(s.enrichment).toEqual({ enabled: false })
    expect('transforms' in s).toBe(false)
    expect(s.models).toEqual({})
    expect(s.savedActions.find((a) => a.id === 'mine')!.provider).toBeUndefined()
  })

  it('keeps a valid Fireworks or OpenAI choice', () => {
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({
        models: { openai: 'gpt-5.4-nano' },
        savedActions: [{ id: 'mine', title: 'Mine', type: 'prompt', prompt: 'x', appliesTo: ['text'], provider: 'fireworks' }]
      })
    )
    _resetSettingsCache()
    const s = getSettings()
    expect(s.models).toEqual({ openai: 'gpt-5.4-nano' })
    expect(s.savedActions.find((a) => a.id === 'mine')!.provider).toBe('fireworks')
  })
})
