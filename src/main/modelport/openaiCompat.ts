import { readFileSync } from 'fs'
import type { ProviderId } from '@shared/types'
import type { PortRequest } from './index'
import { getSettings } from '../settings'
import { apiKeyFor, apiKeySource } from './keys'
import { audioExtension, baseMime } from '../audioFormat'

/**
 * One client for every OpenAI-compatible API. Fireworks and OpenAI expose the same
 * chat-completions wire format, so a provider here is just a base URL + key + model.
 */

interface CompatConfig {
  baseUrl: string
  model: string
  /** OpenAI renamed this; Fireworks still wants the original. */
  maxTokensParam: 'max_completion_tokens' | 'max_tokens'
  /** Extra body fields this provider needs. */
  extra: Record<string, unknown>
  /** Whether the model accepts image input. */
  vision: boolean
}

export const CONFIGS: Record<ProviderId, CompatConfig> = {
  fireworks: {
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    // The pinned deepseek-v4-flash-0731 id started returning 404 and every call
    // silently fell through to OpenAI. v4p1-flash, reasoning off: ~720ms p50, faithful.
    model: 'accounts/fireworks/models/deepseek-v4p1-flash',
    maxTokensParam: 'max_tokens',
    // A reasoning model; reasoning is pure latency for cleanup and tagging, and with
    // it on an exhausted budget comes back as empty `content`.
    extra: { reasoning_effort: 'none' },
    vision: false
  },
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    // gpt-6-luna with reasoning off: ~1.0s p50 and faithful. Luna's default
    // reasoning reworded text the cleanup prompt says must not be touched.
    model: 'gpt-6-luna',
    maxTokensParam: 'max_completion_tokens',
    extra: { reasoning_effort: 'none' },
    vision: true
  }
}

/** What went wrong, in terms the caller can act on. */
export type ProviderErrorKind =
  /** No key configured. */
  | 'no-key'
  /** 401/403: the key is wrong or revoked. */
  | 'key-invalid'
  /** 404: the model id is gone. */
  | 'model-missing'
  /** 402/429: out of credit or rate limited. */
  | 'quota'
  /** 5xx, network error or timeout. */
  | 'unavailable'
  /** Any other 4xx: our request is wrong. */
  | 'bad-request'
  /** 200 with no content. */
  | 'empty'

/**
 * A provider failure. Thrown, never returned as text: an auth error parsed as model
 * output is how tagging stored "Failed to authenticate…" for a month.
 */
export class ProviderError extends Error {
  constructor(
    readonly provider: ProviderId,
    readonly kind: ProviderErrorKind,
    message: string,
    readonly status?: number
  ) {
    super(message)
    this.name = 'ProviderError'
  }

  /** Not the item's fault: the provider itself is unusable right now. */
  get isOutage(): boolean {
    return this.kind !== 'bad-request' && this.kind !== 'empty'
  }
}

const PROVIDER_LABEL: Record<ProviderId, string> = { fireworks: 'Fireworks', openai: 'OpenAI' }

/** Short human text for a status line: "OpenAI key invalid", "Fireworks unavailable". */
export function describeProviderError(err: ProviderError): string {
  const name = PROVIDER_LABEL[err.provider]
  switch (err.kind) {
    case 'no-key':
      return `${name}: no API key`
    case 'key-invalid':
      return `${name} key invalid`
    case 'model-missing':
      return `${name} model not found (${modelFor(err.provider)})`
    case 'quota':
      return `${name} out of credit or rate limited`
    case 'unavailable':
      return `${name} unavailable`
    default:
      return `${name}: ${err.message.slice(0, 120)}`
  }
}

function classifyStatus(status: number): ProviderErrorKind {
  if (status === 401 || status === 403) return 'key-invalid'
  if (status === 404) return 'model-missing'
  if (status === 402 || status === 429) return 'quota'
  if (status >= 500) return 'unavailable'
  return 'bad-request'
}

export function modelFor(provider: ProviderId): string {
  return getSettings().models?.[provider]?.trim() || CONFIGS[provider].model
}

export function supportsVision(provider: ProviderId): boolean {
  return CONFIGS[provider].vision
}

export function openaiCompatAvailable(provider: ProviderId): { ok: boolean; detail: string } {
  return apiKeyFor(provider)
    ? { ok: true, detail: `${modelFor(provider)} via ${apiKeySource(provider)}` }
    : { ok: false, detail: apiKeySource(provider) }
}

function buildBody(provider: ProviderId, req: PortRequest, stream: boolean): Record<string, unknown> {
  const cfg = CONFIGS[provider]
  type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }
  const userContent: ContentPart[] | string = req.imagePath
    ? [
        { type: 'text', text: req.prompt },
        {
          type: 'image_url',
          image_url: { url: `data:image/png;base64,${readFileSync(req.imagePath).toString('base64')}` }
        }
      ]
    : req.prompt
  const body: Record<string, unknown> = {
    model: modelFor(provider),
    messages: [
      ...(req.system ? [{ role: 'system', content: req.system }] : []),
      { role: 'user', content: userContent }
    ],
    [cfg.maxTokensParam]: req.maxTokens ?? 2048,
    ...cfg.extra
  }
  if (req.json) body.response_format = { type: 'json_object' }
  if (stream) body.stream = true
  return body
}

/** fetch with a timeout and an optional caller signal; failures become ProviderErrors. */
async function post(
  provider: ProviderId,
  path: string,
  body: Record<string, unknown> | null,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<Response> {
  const key = apiKeyFor(provider)
  if (!key) throw new ProviderError(provider, 'no-key', `no ${provider} key — add one in Settings`)
  const timeout = AbortSignal.timeout(timeoutMs)
  let res: Response
  try {
    res = await fetch(`${CONFIGS[provider].baseUrl}${path}`, {
      ...(body
        ? { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify(body) }
        : { method: 'GET', headers: { authorization: `Bearer ${key}` } }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout
    })
  } catch (err) {
    // A caller abort is not a provider outage; let it propagate as-is.
    if (signal?.aborted) throw err
    const msg = timeout.aborted ? `timed out after ${timeoutMs}ms` : err instanceof Error ? err.message : String(err)
    throw new ProviderError(provider, 'unavailable', `${provider}: ${msg}`)
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new ProviderError(provider, classifyStatus(res.status), `${provider} HTTP ${res.status}: ${text.slice(0, 200)}`, res.status)
  }
  return res
}

export async function openaiCompatComplete(
  provider: ProviderId,
  req: PortRequest,
  timeoutMs: number
): Promise<string> {
  const res = await post(provider, '/chat/completions', buildBody(provider, req, false), timeoutMs)
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
  const content = data.choices?.[0]?.message?.content
  if (!content) throw new ProviderError(provider, 'empty', `${provider}: empty completion`)
  return content
}

/**
 * Streaming chat completion (server-sent events). Calls onDelta with each text chunk
 * and resolves with the full text. The timeout covers the whole stream.
 */
export async function openaiCompatStream(
  provider: ProviderId,
  req: PortRequest,
  onDelta: (text: string) => void,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<string> {
  const res = await post(provider, '/chat/completions', buildBody(provider, req, true), timeoutMs, signal)
  if (!res.body) throw new ProviderError(provider, 'empty', `${provider}: no response body`)
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
  let buf = ''
  let full = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += value
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (data === '[DONE]') return full
      try {
        const chunk = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> }
        const delta = chunk.choices?.[0]?.delta?.content
        if (delta) {
          full += delta
          onDelta(delta)
        }
      } catch {
        /* keep-alive or partial line; ignore */
      }
    }
  }
  if (!full) throw new ProviderError(provider, 'empty', `${provider}: empty stream`)
  return full
}

/**
 * Check a provider's configured model exists and the key works. Catches a retired
 * model id or a dead key at startup instead of weeks later. OpenAI answers a model
 * lookup (it rejects a 1-token completion with HTTP 400); Fireworks gets a 1-token call.
 */
export async function pingModel(provider: ProviderId): Promise<void> {
  if (provider === 'openai') {
    await post(provider, `/models/${encodeURIComponent(modelFor(provider))}`, null, 10_000)
    return
  }
  await post(
    provider,
    '/chat/completions',
    {
      model: modelFor(provider),
      messages: [{ role: 'user', content: 'ping' }],
      [CONFIGS[provider].maxTokensParam]: 1,
      ...CONFIGS[provider].extra
    },
    10_000
  )
}

/** Cloud transcription via OpenAI (multipart upload). */
export async function openaiTranscribe(audio: Buffer, mime: string): Promise<string> {
  const key = apiKeyFor('openai')
  if (!key) throw new ProviderError('openai', 'no-key', 'no OpenAI key — add one in Settings')
  const form = new FormData()
  // The API identifies the container by FILE EXTENSION, so this must match the actual
  // bytes — sending mp4 as `audio.wav` is a 400, not a guess it recovers from.
  const ext = audioExtension(mime)
  form.append('file', new Blob([new Uint8Array(audio)], { type: baseMime(mime) }), `audio.${ext}`)
  // gpt-4o-mini-transcribe is deprecated (shuts down 2027-02-26).
  form.append('model', 'gpt-transcribe')
  const started = Date.now()
  let res: Response
  try {
    res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}` },
      body: form,
      // Uploads scale with audio length; long takes need more than a chat call.
      signal: AbortSignal.timeout(Math.min(120_000, Math.max(15_000, audio.length / 10)))
    })
  } catch (err) {
    throw new ProviderError('openai', 'unavailable', `transcription: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new ProviderError('openai', classifyStatus(res.status), `transcription HTTP ${res.status}: ${text.slice(0, 200)}`, res.status)
  }
  const data = (await res.json()) as { text?: string }
  console.log(`[modelport] transcribe openai/gpt-transcribe ${Date.now() - started}ms ok`)
  return data.text ?? ''
}
