import { z } from 'zod'
import type { ProviderId, ProviderLane, ProviderStatus } from '@shared/types'
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

const SUBSCRIPTION_LANE: ProviderId[] = ['claude-agent', 'codex']
const API_LANE: ProviderId[] = ['openai', 'gemini']

function laneOf(p: ProviderId): ProviderLane {
  return SUBSCRIPTION_LANE.includes(p) ? 'subscription' : 'api'
}

/** The first provider we would try in a lane, when the configured one is unusable. */
const LANE_DEFAULT: Record<ProviderLane, ProviderId> = {
  subscription: 'claude-agent',
  api: 'openai'
}

/** A provider we actually have a backend for. Stored settings are not typed at runtime. */
function isProviderId(v: unknown): v is ProviderId {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(BACKENDS, v)
}

/**
 * Fallback stays inside the lane the user chose. Silently crossing from the
 * subscription lane to third-party APIs would ship clipboard content to a provider
 * they deliberately didn't pick — a privacy decision, not an availability one.
 */
function fallbacksFor(primary: ProviderId): ProviderId[] {
  const lane = laneOf(primary) === 'subscription' ? SUBSCRIPTION_LANE : API_LANE
  return lane.filter((p) => p !== primary)
}

/**
 * The provider to start from, and the lane the fallback chain must stay inside.
 *
 * An id we have no backend for must NOT be treated as an api-lane provider. laneOf()
 * answers "is it in SUBSCRIPTION_LANE", so anything unrecognised — a typo, or an id
 * retired by a rename — silently answered "api". A real install carried
 * `{ lane: 'subscription', provider: 'claude-cli' }` from before claude-agent was
 * renamed, and every enrichment call was routed to the api lane and failed there,
 * logging `No api-lane provider succeeded` every 15s against a subscription setting.
 *
 * That failure was loud but harmless only because no API keys were present. With one
 * configured it would have quietly sent clipboard content to a third party — exactly
 * the crossing fallbacksFor() promises never to make. So an unknown id recovers inside
 * the lane the user chose, and says so.
 */
function route(feature: Feature): { primary: ProviderId; lane: ProviderLane } {
  const s = getSettings()
  const configured = feature === 'enrichment' ? s.enrichment.provider : s.transforms.provider
  if (isProviderId(configured)) return { primary: configured, lane: laneOf(configured) }
  // transforms has no stored lane; its providers are api-lane by nature.
  const lane: ProviderLane =
    feature === 'enrichment' && s.enrichment.lane === 'subscription' ? 'subscription' : 'api'
  const primary = LANE_DEFAULT[lane]
  console.error(
    `[modelport] ${feature}: unknown provider ${JSON.stringify(configured)}; ` +
      `falling back to ${primary} inside the ${lane} lane. Fix it in Settings → AI Providers.`
  )
  return { primary, lane }
}

export async function complete(
  feature: Feature,
  req: PortRequest,
  providerOverride?: ProviderId
): Promise<string> {
  const routed = route(feature)
  const primary = providerOverride ?? routed.primary
  const lane = providerOverride ? laneOf(providerOverride) : routed.lane
  const order = [primary, ...fallbacksFor(primary)]
  // Graceful last resort, ONE direction only. An api-lane feature (transforms
  // default to OpenAI) with no API key configured falls back to the user's OWN
  // subscription login rather than dying — a subscription-only user shouldn't have
  // dead transforms. The reverse is deliberately never done: a subscription setting
  // must not spill clipboard content to a third-party API the user didn't pick
  // (the fallbacksFor privacy rule). So we only ever ADD the subscription lane.
  if (lane === 'api') order.push(...SUBSCRIPTION_LANE.filter((p) => !order.includes(p)))
  let lastErr: unknown = null
  let crossed = false
  for (const provider of order) {
    try {
      const avail = await isAvailable(provider)
      if (!avail) continue
      if (laneOf(provider) !== lane && !crossed) {
        crossed = true
        console.log(`[modelport] ${feature}: no ${lane}-lane provider available; using ${provider}`)
      }
      return await BACKENDS[provider](req)
    } catch (err) {
      lastErr = err
      console.error(`[modelport] ${provider} failed for ${feature}:`, err)
    }
  }
  throw new Error(
    `No provider succeeded for ${feature} (${String(lastErr ?? 'none available')}). ` +
      'Check Settings → AI Providers.'
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

/**
 * Forget cached availability. Called when settings change: a key pasted into Settings
 * must take effect now, not up to five minutes later, or the field looks broken.
 */
export function resetProviderCache(): void {
  availCache.clear()
}

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
