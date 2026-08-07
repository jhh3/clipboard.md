import { app, nativeImage } from 'electron'
import { writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'
import type { BuiltinTransformId, TransformRequest, TransformResult, SavedAction } from '@shared/types'
import { getItem, upsertClip } from './store/items'
import { detectSecret } from './capture/filters'
import { getSettings } from './settings'

type TextFn = (s: string) => string

const TEXT_BUILTINS: Partial<Record<BuiltinTransformId, TextFn>> = {
  'plain-text': (s) => s,
  trim: (s) => s.trim(),
  lowercase: (s) => s.toLowerCase(),
  uppercase: (s) => s.toUpperCase(),
  'title-case': (s) => s.replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase()),
  'json-pretty': (s) => JSON.stringify(JSON.parse(s), null, 2),
  'json-minify': (s) => JSON.stringify(JSON.parse(s)),
  'url-encode': (s) => encodeURIComponent(s),
  'url-decode': (s) => decodeURIComponent(s),
  'base64-encode': (s) => Buffer.from(s, 'utf8').toString('base64'),
  'base64-decode': (s) => Buffer.from(s, 'base64').toString('utf8'),
  'strip-quotes': (s) => s.replace(/^["'`\s]+|["'`\s]+$/g, ''),
  'single-line': (s) => s.replace(/\s*\n\s*/g, ' ').trim(),
  'markdown-strip': (s) =>
    s
      .replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*\n?|```/g, ''))
      .replace(/[*_~`#>]+/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
}

/** AI lane hook — wired to ModelPort when it lands; kept as a seam so transforms.ts has no provider knowledge. */
export type AiTransformFn = (
  prompt: string,
  content: string,
  isImagePath?: string,
  provider?: import('@shared/types').ProviderId
) => Promise<string>
let aiTransform: AiTransformFn | null = null

export function setAiTransform(fn: AiTransformFn): void {
  aiTransform = fn
}

function findAction(actionId: string): SavedAction | undefined {
  return getSettings().savedActions.find((a) => a.id === actionId)
}

export async function runTransform(req: TransformRequest): Promise<TransformResult> {
  const item = getItem(req.itemId)
  if (!item) return { ok: false, error: 'Item not found' }
  // The UI promises secrets are never sent to a model — honour that here, where it
  // is actually enforceable, rather than trusting every call site.
  if (item.secret) {
    const isAi = req.freePrompt || findAction(req.actionId ?? '')?.type === 'prompt'
    if (isAi) return { ok: false, error: 'This clip is flagged as a secret — AI actions are blocked' }
  }

  try {
    // Free-text prompt → AI lane.
    if (req.freePrompt) {
      return await runAi(req.freePrompt, item.kind === 'image' ? '' : item.content, item.kind === 'image' ? item.content : undefined)
    }

    const action = req.actionId ? findAction(req.actionId) : undefined
    if (!action) return { ok: false, error: 'Unknown action' }

    if (action.type === 'prompt') {
      return await runAi(
        action.prompt ?? '',
        item.kind === 'image' ? '' : item.content,
        item.kind === 'image' ? item.content : undefined,
        action.provider
      )
    }

    const id = action.builtinId!
    if (id.startsWith('img-')) {
      if (item.kind !== 'image') return { ok: false, error: 'Not an image' }
      if (id === 'img-redact') {
        const { autoRedact } = await import('./imageops')
        const { png, count } = await autoRedact(item.content)
        if (count === 0) return { ok: false, error: 'No sensitive-looking text found to redact' }
        return {
          ok: true,
          output: `data:image/png;base64,${png.toString('base64')}`,
          outputKind: 'image'
        }
      }
      const img = nativeImage.createFromPath(item.content)
      if (img.isEmpty()) return { ok: false, error: 'Image unreadable' }
      const out =
        id === 'img-jpeg'
          ? `data:image/jpeg;base64,${img.toJPEG(90).toString('base64')}`
          : id === 'img-compress'
            ? `data:image/jpeg;base64,${img.toJPEG(70).toString('base64')}`
            : img.toDataURL()
      return { ok: true, output: out, outputKind: 'image' }
    }

    const fn = TEXT_BUILTINS[id]
    if (!fn) return { ok: false, error: `Builtin ${id} not implemented` }
    return { ok: true, output: fn(item.content), outputKind: 'text' }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

async function runAi(
  prompt: string,
  content: string,
  imagePath?: string,
  provider?: import('@shared/types').ProviderId
): Promise<TransformResult> {
  if (!aiTransform) {
    return { ok: false, error: 'AI transforms not configured yet — set up a provider in Settings' }
  }
  const output = await aiTransform(prompt, content, imagePath, provider)
  return { ok: true, output, outputKind: 'text' }
}

/** Persist a transform result as a derived clip; returns the new id. */
export function commitTransform(
  req: TransformRequest & { output: string; outputKind: 'text' | 'image' }
): number {
  const via = req.freePrompt
    ? `prompt: ${req.freePrompt.slice(0, 80)}`
    : findAction(req.actionId ?? '')?.title ?? 'transform'
  // A derived clip inherits its source's secret flag, and is re-scanned on its own
  // merits — otherwise "trim whitespace" laundered a secret into an indexed clip.
  const source = getItem(req.itemId)
  const secret =
    !!source?.secret || (req.outputKind === 'text' && detectSecret(req.output) !== null)

  if (req.outputKind === 'image') {
    // Image outputs come back as data URLs; store as file alongside captures.
    const img = nativeImage.createFromDataURL(req.output)
    const png = img.toPNG()
    const sha = createHash('sha256').update(png).digest('hex')
    const dir = join(app.getPath('userData'), 'data', 'images')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `${sha}.png`)
    if (!existsSync(file)) writeFileSync(file, png)
    const { width, height } = img.getSize()
    const { id } = upsertClip({
      kind: 'image',
      content: file,
      preview: `Image ${width}x${height}`,
      thumb: img.resize({ width: Math.min(320, width) }).toDataURL(),
      width,
      height,
      secret,
      derivedFrom: req.itemId,
      derivedVia: via
    })
    return id
  }

  const { id } = upsertClip({
    kind: 'text',
    content: req.output,
    preview: req.output.slice(0, 500),
    secret,
    derivedFrom: req.itemId,
    derivedVia: via
  })
  return id
}
