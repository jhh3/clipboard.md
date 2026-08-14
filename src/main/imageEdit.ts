import { nativeImage } from 'electron'
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
  // NOT the Lite model, despite Lite being ~2x faster.
  //
  // Measured on the same screenshot with the same instruction ("blur out all of
  // the email addresses"): Lite returned a faithful re-render with two stray
  // smudges in empty space and every address still legible (4.6s); this model
  // blurred all eight and touched nothing else (9.0s). Lite does comply with
  // blunt whole-image instructions ("thick blue border, red TEXT in the corner"),
  // but localized semantic edits — the only kind anyone actually asks for — come
  // back as a no-op that is indistinguishable from success. 4s of "nothing
  // happened" is worse than 9s of the edit.
  gemini: 'gemini-3.1-flash-image',
  openai: 'gpt-image-2'
}

function mimeFor(path: string): string {
  return path.toLowerCase().endsWith('.jpg') || path.toLowerCase().endsWith('.jpeg')
    ? 'image/jpeg'
    : 'image/png'
}

/**
 * Log every edit, because a bad edit is invisible from the outside.
 *
 * A model that ignores the instruction returns a re-render of the input, so the
 * app sees a perfectly valid image and reports success. Without the model name,
 * the instruction and the two sizes on one line, diagnosing "it didn't do
 * anything" means digging the clips back out of sqlite and diffing PNG headers.
 *
 * The instruction is logged (truncated) rather than just its length: it is the
 * user's own text, not captured clipboard content, it is already being sent to a
 * third-party API, and it is the one field that makes the line worth having.
 * Clip content is still never logged, and the transport redactor still runs.
 */
function logEdit(
  model: string,
  prompt: string,
  ms: number,
  inputPath: string,
  outputB64: string,
  mime: string,
  note?: string
): void {
  const before = nativeImage.createFromPath(inputPath).getSize()
  const after = nativeImage.createFromBuffer(Buffer.from(outputB64, 'base64')).getSize()
  // Gemini renormalizes to ~1MP and answers in JPEG, so a screenshot of text comes
  // back smaller and re-compressed even when the edit itself is correct. Flag it
  // rather than let the quality loss be a mystery.
  const shrunk = after.width < before.width || after.height < before.height
  console.log(
    `[imageEdit] ${model} ${ms}ms ${before.width}x${before.height} -> ${after.width}x${after.height} ` +
      `${mime}${shrunk ? ' (DOWNSCALED)' : ''} prompt=${JSON.stringify(prompt.slice(0, 120))}` +
      (note ? ` note=${JSON.stringify(note.slice(0, 200))}` : '')
  )
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
  const started = Date.now()
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
        // TEXT as well as IMAGE. With IMAGE alone the model has no channel to
        // decline, ask a question, or explain a partial edit — it can only emit
        // pixels, so a refusal is byte-indistinguishable from a successful edit.
        // Any text it does return is surfaced below instead of being dropped.
        generationConfig: { responseModalities: ['TEXT', 'IMAGE'] }
      }),
      signal: AbortSignal.timeout(120_000)
    }
  )
  const ms = Date.now() - started
  if (!res.ok) throw new Error(`Gemini image edit failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`)
  const data = (await res.json()) as {
    candidates?: Array<{
      finishReason?: string
      content?: { parts?: Array<{ text?: string; inlineData?: { mimeType?: string; data?: string } }> }
    }>
  }
  const parts = data.candidates?.[0]?.content?.parts ?? []
  const said = parts
    .map((p) => p.text)
    .filter((t): t is string => !!t?.trim())
    .join(' ')
    .trim()
  const part = parts.find((p) => p.inlineData?.data)
  if (!part?.inlineData?.data) {
    // The model talked instead of drawing — that text is the actual explanation,
    // so give it to the user rather than the generic failure.
    throw new Error(said || `The model returned no image (finish: ${data.candidates?.[0]?.finishReason ?? 'unknown'})`)
  }
  const mime = part.inlineData.mimeType ?? 'image/png'
  logEdit(model, prompt, ms, imagePath, part.inlineData.data, mime, said)
  return `data:${mime};base64,${part.inlineData.data}`
}

async function editWithOpenAI(imagePath: string, prompt: string, model: string): Promise<string> {
  const key = apiKeyFor('openai')
  if (!key) throw new Error('no OpenAI key — add one in Settings')
  const started = Date.now()
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
  logEdit(model, prompt, Date.now() - started, imagePath, b64, 'image/png')
  return `data:image/png;base64,${b64}`
}
