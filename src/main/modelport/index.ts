import { z } from 'zod'
import type { ProviderId, ProviderStatus } from '@shared/types'
import { getSettings } from '../settings'
import { openaiCompatComplete, openaiCompatAvailable } from './openaiCompat'
import { claudeAgentComplete, claudeAgentAvailable } from './claudeAgent'
import { codexComplete, codexAvailable } from './codex'

/**
 * ModelPort: the single seam between the app and any AI backend.
 * The app core is agnostic to subscription vs API vs model — per-feature routing
 * lives in settings, and every backend implements the same call shape.
 */

export interface PortRequest {
  system?: string
  prompt: string
  /** Absolute path to an image to include (vision). */
  imagePath?: string
  /** When set, the backend must return JSON parseable against this schema. */
  json?: boolean
  maxTokens?: number
}

export type Feature = 'enrichment' | 'transforms'

type Backend = (req: PortRequest) => Promise<string>

const BACKENDS: Record<ProviderId, Backend> = {
  'claude-agent': claudeAgentComplete,
  codex: codexComplete,
  openai: (req) => openaiCompatComplete('openai', req),
  gemini: (req) => openaiCompatComplete('gemini', req)
}

/** Fallback order when the routed provider fails or is unavailable (subscription first). */
const FALLBACKS: ProviderId[] = ['claude-agent', 'codex', 'openai', 'gemini']

function routedProvider(feature: Feature): ProviderId {
  const s = getSettings()
  return feature === 'enrichment' ? s.enrichment.provider : s.transforms.provider
}

export async function complete(feature: Feature, req: PortRequest): Promise<string> {
  const primary = routedProvider(feature)
  const order = [primary, ...FALLBACKS.filter((p) => p !== primary)]
  let lastErr: unknown = null
  for (const provider of order) {
    try {
      const avail = await isAvailable(provider)
      if (!avail) continue
      return await BACKENDS[provider](req)
    } catch (err) {
      lastErr = err
      console.error(`[modelport] ${provider} failed for ${feature}:`, err)
    }
  }
  throw new Error(
    `No AI provider succeeded (${String(lastErr ?? 'none available')}). Check Settings → AI Providers.`
  )
}

/** JSON-schema completion with zod validation and one repair retry. */
export async function completeJson<T>(
  feature: Feature,
  req: PortRequest,
  schema: z.ZodType<T>
): Promise<T> {
  const jsonReq = { ...req, json: true }
  const raw = await complete(feature, jsonReq)
  const parsed = tryParse(raw, schema)
  if (parsed.ok) return parsed.value
  // One repair attempt: feed the error back.
  const repaired = await complete(feature, {
    ...jsonReq,
    prompt: `${req.prompt}\n\nYour previous output failed validation: ${parsed.error}\nPrevious output:\n${raw.slice(0, 2000)}\nReturn ONLY corrected JSON.`
  })
  const second = tryParse(repaired, schema)
  if (second.ok) return second.value
  throw new Error(`invalid JSON from provider after retry: ${second.error}`)
}

function tryParse<T>(
  raw: string,
  schema: z.ZodType<T>
): { ok: true; value: T } | { ok: false; error: string } {
  // Providers occasionally wrap JSON in fences or prose; extract the outermost object.
  const stripped = raw.replace(/^```(?:json)?\s*|\s*```$/g, '').trim()
  const start = stripped.indexOf('{')
  const end = stripped.lastIndexOf('}')
  const candidate = start >= 0 && end > start ? stripped.slice(start, end + 1) : stripped
  try {
    const value = schema.parse(JSON.parse(candidate))
    return { ok: true, value }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message.slice(0, 300) : String(err) }
  }
}

const availCache = new Map<ProviderId, { at: number; ok: boolean; detail: string }>()

export async function isAvailable(provider: ProviderId): Promise<boolean> {
  const cached = availCache.get(provider)
  if (cached && Date.now() - cached.at < 5 * 60_000) return cached.ok
  let ok = false
  let detail = ''
  try {
    switch (provider) {
      case 'openai':
        ;({ ok, detail } = openaiCompatAvailable('openai'))
        break
      case 'gemini':
        ;({ ok, detail } = openaiCompatAvailable('gemini'))
        break
      case 'claude-agent':
        ;({ ok, detail } = await claudeAgentAvailable())
        break
      case 'codex':
        ;({ ok, detail } = await codexAvailable())
        break
    }
  } catch (err) {
    detail = String(err)
  }
  availCache.set(provider, { at: Date.now(), ok, detail })
  return ok
}

export async function providersStatus(): Promise<ProviderStatus[]> {
  const ids: ProviderId[] = ['claude-agent', 'codex', 'openai', 'gemini']
  return Promise.all(
    ids.map(async (id) => {
      const ok = await isAvailable(id)
      const cached = availCache.get(id)
      return {
        id,
        lane: id === 'claude-agent' || id === 'codex' ? ('subscription' as const) : ('api' as const),
        available: ok,
        detail: cached?.detail ?? ''
      }
    })
  )
}
