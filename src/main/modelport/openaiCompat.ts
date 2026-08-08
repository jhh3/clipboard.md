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

export function openaiCompatAvailable(provider: 'openai' | 'gemini'): { ok: boolean; detail: string } {
  const key = process.env[CONFIGS[provider].keyEnv]
  return key
    ? { ok: true, detail: `${CONFIGS[provider].model} via ${CONFIGS[provider].keyEnv}` }
    : { ok: false, detail: `${CONFIGS[provider].keyEnv} not set` }
}

export async function openaiCompatComplete(
  provider: 'openai' | 'gemini',
  req: PortRequest
): Promise<string> {
  const cfg = CONFIGS[provider]
  const key = process.env[cfg.keyEnv]
  if (!key) throw new Error(`${cfg.keyEnv} not set`)

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
  const key = process.env.OPENAI_API_KEY
  if (!key) throw new Error('OPENAI_API_KEY not set')
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
