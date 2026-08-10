import { readFileSync } from 'fs'
import type { PortRequest } from './index'
import { getSettings } from '../settings'
import { audioExtension, baseMime } from '../audioFormat'

/**
 * One client for every OpenAI-compatible API. OpenAI and Gemini expose the same
 * chat-completions wire format, so a provider here is just a base URL + key + model.
 */

interface CompatConfig {
  baseUrl: string
  keyEnv: string
  model: string
}

const CONFIGS: Record<'openai' | 'gemini', CompatConfig> = {
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    keyEnv: 'OPENAI_API_KEY',
    model: 'gpt-5.6-luna'
  },
  gemini: {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyEnv: 'GEMINI_API_KEY',
    model: 'gemini-flash-lite-latest'
  }
}

/**
 * The API key, from Settings first and the environment second.
 *
 * Environment-only was unworkable for a desktop app. Keys live in a shell rc, and the
 * app is started by the session (autostart, a .desktop launcher, systemd) — none of
 * which source it. The result was an app that could see no providers at all while
 * `echo $OPENAI_API_KEY` in a terminal printed one, and the only symptom was
 * "No api-lane provider succeeded (none available)" on a loop.
 *
 * The environment still wins nothing and loses nothing: it remains the fallback, so
 * an app launched from a shell, or a headless --mcp server, keeps working unchanged.
 */
function keyFor(provider: 'openai' | 'gemini'): string | undefined {
  const fromSettings = getSettings().apiKeys?.[provider]?.trim()
  return fromSettings || process.env[CONFIGS[provider].keyEnv] || undefined
}

export function openaiCompatAvailable(provider: 'openai' | 'gemini'): { ok: boolean; detail: string } {
  const fromSettings = !!getSettings().apiKeys?.[provider]?.trim()
  const key = keyFor(provider)
  return key
    ? {
        ok: true,
        detail: `${CONFIGS[provider].model} via ${fromSettings ? 'Settings' : CONFIGS[provider].keyEnv}`
      }
    : { ok: false, detail: `no key in Settings or ${CONFIGS[provider].keyEnv}` }
}

export async function openaiCompatComplete(
  provider: 'openai' | 'gemini',
  req: PortRequest
): Promise<string> {
  const cfg = CONFIGS[provider]
  const key = keyFor(provider)
  if (!key) throw new Error(`no ${provider} key in Settings or ${cfg.keyEnv}`)

  type ContentPart =
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string } }

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
    model: getSettings().models[provider] ?? cfg.model,
    messages: [
      ...(req.system ? [{ role: 'system', content: req.system }] : []),
      { role: 'user', content: userContent }
    ],
    max_completion_tokens: req.maxTokens ?? 2048
  }
  if (req.json) body.response_format = { type: 'json_object' }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 90_000)
  try {
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: controller.signal
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`${provider} HTTP ${res.status}: ${text.slice(0, 200)}`)
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>
    }
    const content = data.choices?.[0]?.message?.content
    if (!content) throw new Error(`${provider}: empty completion`)
    return content
  } finally {
    clearTimeout(timer)
  }
}

/** Whisper-family transcription via OpenAI (multipart upload). */
export async function openaiTranscribe(audio: Buffer, mime: string): Promise<string> {
  // Same source as every other call: Settings first, environment second. This one
  // was missed and stayed environment-only, so cloud transcription would fail with
  // "OPENAI_API_KEY not set" for a user whose key was sitting in Settings.
  const key = keyFor('openai')
  if (!key) throw new Error('no OpenAI key in Settings or OPENAI_API_KEY')
  const form = new FormData()
  // The API identifies the container by FILE EXTENSION, so this must match the actual
  // bytes — sending mp4 as `audio.wav` is a 400, not a guess it recovers from.
  const ext = audioExtension(mime)
  form.append('file', new Blob([new Uint8Array(audio)], { type: baseMime(mime) }), `audio.${ext}`)
  form.append('model', 'gpt-4o-mini-transcribe')
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}` },
    body: form
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`transcription HTTP ${res.status}: ${text.slice(0, 200)}`)
  }
  const data = (await res.json()) as { text?: string }
  return data.text ?? ''
}
