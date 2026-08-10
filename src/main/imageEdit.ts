import { readFileSync } from 'fs'
import { getSettings } from './settings'
import { apiKeyFor } from './modelport/keys'

/**
 * AI image editing: an image clip + an instruction in, an edited image out.
 *
 * Providers are the two image-editing APIs behind keys the app already uses:
 *  - Gemini's image models ("Nano Banana" family) via generateContent with an
 *    inline image part — verified live: Nano Banana 2 Lite round-trips an edit
 *    in ~3s, which is why it is the default
 *  - OpenAI's gpt-image family via /v1/images/edits (multipart)
 *
 * Output is a data URL, which is exactly what the transform pipeline already
 * speaks (img-redact et al.) — preview, paste and commit all work unchanged.
 */

export const IMAGE_EDIT_DEFAULTS: Record<'gemini' | 'openai', string> = {
  // Verified against the live models list: displayName "Nano Banana 2 Lite".
  gemini: 'gemini-3.1-flash-lite-image',
  openai: 'gpt-image-2'
}

function mimeFor(path: string): string {
  return path.toLowerCase().endsWith('.jpg') || path.toLowerCase().endsWith('.jpeg')
    ? 'image/jpeg'
    : 'image/png'
}

export async function editImage(imagePath: string, prompt: string): Promise<string> {
  const cfg = getSettings().imageEdit
  const provider = cfg.provider ?? 'gemini'
  const model = cfg.model || IMAGE_EDIT_DEFAULTS[provider]
  return provider === 'openai'
    ? editWithOpenAI(imagePath, prompt, model)
    : editWithGemini(imagePath, prompt, model)
}

async function editWithGemini(imagePath: string, prompt: string, model: string): Promise<string> {
  const key = apiKeyFor('gemini')
  if (!key) throw new Error('no Gemini key — add one in Settings')
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                inline_data: {
                  mime_type: mimeFor(imagePath),
                  data: readFileSync(imagePath).toString('base64')
                }
              },
              { text: prompt }
            ]
          }
        ],
        generationConfig: { responseModalities: ['IMAGE'] }
      }),
      signal: AbortSignal.timeout(120_000)
    }
  )
  if (!res.ok) throw new Error(`Gemini image edit failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`)
  const data = (await res.json()) as {
    candidates?: Array<{
      content?: { parts?: Array<{ inlineData?: { mimeType?: string; data?: string } }> }
    }>
  }
  const part = data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)
  if (!part?.inlineData?.data) throw new Error('The model returned no image')
  return `data:${part.inlineData.mimeType ?? 'image/png'};base64,${part.inlineData.data}`
}

async function editWithOpenAI(imagePath: string, prompt: string, model: string): Promise<string> {
  const key = apiKeyFor('openai')
  if (!key) throw new Error('no OpenAI key — add one in Settings')
  const form = new FormData()
  form.append('model', model)
  form.append('prompt', prompt)
  form.append(
    'image',
    new Blob([readFileSync(imagePath)], { type: mimeFor(imagePath) }),
    imagePath.endsWith('.jpg') ? 'image.jpg' : 'image.png'
  )
  const res = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}` },
    body: form,
    signal: AbortSignal.timeout(180_000)
  })
  if (!res.ok) throw new Error(`OpenAI image edit failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`)
  const data = (await res.json()) as { data?: Array<{ b64_json?: string }> }
  const b64 = data.data?.[0]?.b64_json
  if (!b64) throw new Error('The model returned no image')
  return `data:image/png;base64,${b64}`
}
