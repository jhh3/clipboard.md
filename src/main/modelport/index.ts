import { z } from 'zod'
import type { ProviderId, ProviderStatus } from '@shared/types'
import { apiKeyFor } from './keys'
import {
  ProviderError,
  describeProviderError,
  modelFor,
  openaiCompatAvailable,
  openaiCompatComplete,
  openaiCompatStream,
  pingModel,
  supportsVision
} from './openaiCompat'

export { ProviderError, describeProviderError } from './openaiCompat'

/**
 * ModelPort: the single seam between the app and an AI backend. Every call is a
 * direct API request — Fireworks first when it has a key (fastest), then OpenAI.
 * Failures are thrown as ProviderError so callers can tell "the provider is down"
 * from "this input is bad", and every call logs provider, model and ms.
 */

export interface PortRequest {
  system?: string
  prompt: string
  /** Absolute path to an image to include (vision; OpenAI only). */
  imagePath?: string
  /** When set, the backend must return a JSON object. */
  json?: boolean
  maxTokens?: number
  /** Per-call timeout. Default 8s, or 30s with an image. */
  timeoutMs?: number
}

export type Feature = 'enrichment' | 'transforms'

const ORDER: ProviderId[] = ['fireworks', 'openai']

/** Providers to try, in order: an explicit override first, then those with a key. */
function providerOrder(req: PortRequest, override?: ProviderId): ProviderId[] {
  const order = override && ORDER.includes(override) ? [override, ...ORDER.filter((p) => p !== override)] : ORDER
  return order.filter((p) => apiKeyFor(p) && (!req.imagePath || supportsVision(p)))
}

function timeoutFor(req: PortRequest): number {
  return req.timeoutMs ?? (req.imagePath ? 30_000 : 8_000)
}

/** Every failure, in order, for a single error that says what was tried. */
function noProvider(feature: Feature, req: PortRequest, errors: ProviderError[]): ProviderError {
  if (errors.length === 0) {
    const what = req.imagePath ? 'an OpenAI key (image input)' : 'a Fireworks or OpenAI key'
    return new ProviderError('openai', 'no-key', `${feature}: no provider configured — add ${what} in Settings`)
  }
  // Surface the last error: it carries the kind the caller acts on.
  const last = errors[errors.length - 1]
  return new ProviderError(last.provider, last.kind, errors.map((e) => e.message).join('; '), last.status)
}

async function attempt<T>(
  feature: Feature,
  req: PortRequest,
  override: ProviderId | undefined,
  run: (provider: ProviderId, timeoutMs: number) => Promise<T>,
  /** Stop falling back once output has reached the caller (a stream mid-flight). */
  committed: () => boolean = () => false
): Promise<T> {
  const errors: ProviderError[] = []
  for (const provider of providerOrder(req, override)) {
    const started = Date.now()
    try {
      const out = await run(provider, timeoutFor(req))
      setProblem(provider, undefined)
      console.log(`[modelport] ${feature} ${provider}/${modelFor(provider)} ${Date.now() - started}ms ok`)
      return out
    } catch (err) {
      const ms = Date.now() - started
      if (!(err instanceof ProviderError)) throw err
      console.error(`[modelport] ${feature} ${provider}/${modelFor(provider)} ${ms}ms failed: ${err.kind}: ${err.message.slice(0, 200)}`)
      noteFailure(err)
      errors.push(err)
      if (committed()) break
    }
  }
  throw noProvider(feature, req, errors)
}

export async function complete(feature: Feature, req: PortRequest, providerOverride?: ProviderId): Promise<string> {
  return attempt(feature, req, providerOverride, (p, t) => openaiCompatComplete(p, req, t))
}

/**
 * Streaming completion for one-shot answers. onDelta receives each text chunk; the
 * promise resolves with the full text. Falls back to the next provider only if the
 * first one failed before producing any text.
 */
export async function streamComplete(
  feature: Feature,
  req: PortRequest,
  onDelta: (text: string) => void,
  signal?: AbortSignal
): Promise<string> {
  let started = false
  const forward = (t: string): void => {
    started = true
    onDelta(t)
  }
  // Streams run longer than a single round trip; the timeout covers the whole answer.
  const streamReq = { ...req, timeoutMs: req.timeoutMs ?? 60_000 }
  return attempt(feature, streamReq, undefined, (p, t) => openaiCompatStream(p, streamReq, forward, t, signal), () => started)
}

/** JSON completion with zod validation and one repair retry. */
export async function completeJson<T>(feature: Feature, req: PortRequest, schema: z.ZodType<T>): Promise<T> {
  const jsonReq = { ...req, json: true }
  const raw = await complete(feature, jsonReq)
  const parsed = tryParse(raw, schema)
  if (parsed.ok) return parsed.value
  const repaired = await complete(feature, {
    ...jsonReq,
    prompt: `${req.prompt}\n\nYour previous output failed validation: ${parsed.error}\nPrevious output:\n${raw.slice(0, 2000)}\nReturn ONLY corrected JSON.`
  })
  const second = tryParse(repaired, schema)
  if (second.ok) return second.value
  throw new Error(`invalid JSON from provider after retry: ${second.error}`)
}

export function tryParse<T>(raw: string, schema: z.ZodType<T>): { ok: true; value: T } | { ok: false; error: string } {
  // Providers occasionally wrap JSON in fences or prose; extract the outermost object.
  const stripped = raw.replace(/^```(?:json)?\s*|\s*```$/g, '').trim()
  const start = stripped.indexOf('{')
  const end = stripped.lastIndexOf('}')
  const candidate = start >= 0 && end > start ? stripped.slice(start, end + 1) : stripped
  try {
    return { ok: true, value: schema.parse(JSON.parse(candidate)) }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message.slice(0, 300) : String(err) }
  }
}

/** Last outage seen per provider, cleared by a success or a settings change. */
const problems = new Map<ProviderId, string>()
const problemListeners = new Set<() => void>()

function setProblem(provider: ProviderId, problem: string | undefined): void {
  if (problems.get(provider) === problem) return
  if (problem) problems.set(provider, problem)
  else problems.delete(provider)
  for (const fn of problemListeners) fn()
}

function noteFailure(err: ProviderError): void {
  if (err.isOutage && err.kind !== 'no-key') setProblem(err.provider, describeProviderError(err))
}

/** Current provider problems ("Fireworks model not found …"), for the tray. */
export function providerProblems(): string[] {
  return [...problems.values()]
}

export function onProviderProblems(fn: () => void): () => void {
  problemListeners.add(fn)
  return () => problemListeners.delete(fn)
}

/** Forget cached problems. Called when settings change: a new key must take effect now. */
export function resetProviderCache(): void {
  if (problems.size === 0) return
  problems.clear()
  for (const fn of problemListeners) fn()
}

export async function providersStatus(): Promise<ProviderStatus[]> {
  return ORDER.map((id) => {
    const { ok, detail } = openaiCompatAvailable(id)
    const problem = problems.get(id)
    return { id, available: ok && !problem, detail: problem ?? detail }
  })
}

/**
 * Startup check: ping each configured model once. A retired model id (the Fireworks
 * 404) or a dead key used to stay invisible for weeks behind the fallback.
 */
export async function checkModels(): Promise<string[]> {
  const failures: string[] = []
  await Promise.all(
    ORDER.filter((p) => apiKeyFor(p)).map(async (p) => {
      const started = Date.now()
      try {
        await pingModel(p)
        setProblem(p, undefined)
        console.log(`[modelport] check ${p}/${modelFor(p)} ${Date.now() - started}ms ok`)
      } catch (err) {
        const msg = err instanceof ProviderError ? describeProviderError(err) : String(err)
        if (err instanceof ProviderError) noteFailure(err)
        failures.push(msg)
        console.error(`[modelport] check ${p}/${modelFor(p)} failed: ${msg}`)
      }
    })
  )
  return failures
}
