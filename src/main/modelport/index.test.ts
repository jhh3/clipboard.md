import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { AppSettings } from '@shared/types'

const settings: Partial<AppSettings> = { apiKeys: {}, models: {} }
vi.mock('../settings', () => ({ getSettings: () => settings }))

const { complete, completeJson, streamComplete, providersStatus, checkModels, ProviderError, resetProviderCache } =
  await import('./index')

type Call = { url: string; body: Record<string, unknown> }
let calls: Call[] = []

function reply(status: number, body: unknown): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
}
const ok = (content: string): Response => reply(200, { choices: [{ message: { content } }] })

function mockFetch(handler: (call: Call) => Response | Promise<Response>): void {
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const call = { url, body: init.body ? JSON.parse(String(init.body)) : {} }
    calls.push(call)
    return handler(call)
  })
}

beforeEach(() => {
  calls = []
  settings.apiKeys = { fireworks: 'fw', openai: 'oa' }
  settings.models = {}
  resetProviderCache()
})
afterEach(() => vi.unstubAllGlobals())

describe('modelport', () => {
  it('tries Fireworks first with reasoning off, on the current model ids', async () => {
    mockFetch(() => ok('hi'))
    expect(await complete('transforms', { prompt: 'x' })).toBe('hi')
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toContain('api.fireworks.ai')
    expect(calls[0].body.model).toBe('accounts/fireworks/models/deepseek-v4p1-flash')
    expect(calls[0].body.reasoning_effort).toBe('none')
  })

  it('falls back to OpenAI (gpt-6-luna, reasoning none) when Fireworks fails', async () => {
    mockFetch((c) => (c.url.includes('fireworks') ? reply(404, 'not found') : ok('from openai')))
    expect(await complete('transforms', { prompt: 'x' })).toBe('from openai')
    expect(calls[1].body.model).toBe('gpt-6-luna')
    expect(calls[1].body.reasoning_effort).toBe('none')
    const status = await providersStatus()
    expect(status.find((s) => s.id === 'fireworks')).toMatchObject({ available: false })
    expect(status.find((s) => s.id === 'fireworks')!.detail).toMatch(/model not found/)
  })

  it('throws a classified error instead of returning an error body as output', async () => {
    mockFetch(() => reply(401, 'invalid key'))
    const err = await complete('enrichment', { prompt: 'x' }).catch((e) => e)
    expect(err).toBeInstanceOf(ProviderError)
    expect(err.kind).toBe('key-invalid')
    expect(err.isOutage).toBe(true)
  })

  it('reports no-key as an outage without calling anything', async () => {
    settings.apiKeys = {}
    mockFetch(() => ok('never'))
    const err = await complete('enrichment', { prompt: 'x' }).catch((e) => e)
    expect(err.kind).toBe('no-key')
    expect(calls).toHaveLength(0)
  })

  it('never sends an image to the text-only provider', async () => {
    mockFetch(() => ok('described'))
    await complete('transforms', { prompt: 'x', imagePath: __filename })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toContain('api.openai.com')
  })

  it('times out a hung call and moves on', async () => {
    mockFetch(
      (c) =>
        new Promise<Response>((resolve, reject) => {
          if (!c.url.includes('fireworks')) return resolve(ok('fast'))
          setTimeout(() => reject(new DOMException('aborted', 'TimeoutError')), 50)
        })
    )
    expect(await complete('transforms', { prompt: 'x', timeoutMs: 20 })).toBe('fast')
  })

  it('repairs invalid JSON once', async () => {
    let n = 0
    mockFetch(() => ok(n++ === 0 ? 'not json' : '{"a": 1}'))
    expect(await completeJson('enrichment', { prompt: 'x' }, z.object({ a: z.number() }))).toEqual({ a: 1 })
  })

  it('streams deltas and resolves with the full text', async () => {
    const sse = ['data: {"choices":[{"delta":{"content":"Hel"}}]}', 'data: {"choices":[{"delta":{"content":"lo"}}]}', 'data: [DONE]', '']
    mockFetch(() => new Response(sse.join('\n\n'), { status: 200 }))
    const deltas: string[] = []
    expect(await streamComplete('transforms', { prompt: 'x' }, (d) => deltas.push(d))).toBe('Hello')
    expect(deltas).toEqual(['Hel', 'lo'])
    expect(calls[0].body.stream).toBe(true)
  })

  it('pings each configured model at startup and returns the failures', async () => {
    settings.apiKeys = { fireworks: 'fw', openai: 'oa' }
    mockFetch((c) => (c.url.includes('fireworks') ? reply(404, 'gone') : ok('')))
    const failures = await checkModels()
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatch(/Fireworks model not found/)
    expect(calls.find((c) => c.url.includes('fireworks'))!.body.max_tokens).toBe(1)
    expect(calls.find((c) => c.url.includes('openai'))!.url).toBe('https://api.openai.com/v1/models/gpt-6-luna')
  })
})
