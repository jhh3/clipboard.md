import { randomUUID } from 'crypto'
import { complete } from './modelport'
import { getItem } from './store/items'

/**
 * The palette's one-shot "ask" and the ⌘⇧R rewrite: a single direct API call each,
 * no session, no agent process. The answer streams back as deltas so the first words
 * show while the model is still writing.
 */

const ASK_SYSTEM =
  'You are a fast, concise assistant inside a clipboard manager. Answer directly. ' +
  'Use markdown only when it helps (code blocks, short lists). No preamble.'

const REWRITE_SYSTEM =
  'Rewrite the text below as instructed. Preserve meaning, formatting, line breaks, ' +
  'code and links unless the instruction says otherwise. Output only the rewritten ' +
  'text: no preamble, no quotes, no explanation.'

export const FIX_TYPOS =
  'Fix spelling, grammar and punctuation. Keep the wording and tone exactly as written.'

const MAX_CLIP_CHARS = 20_000

const inflight = new Map<string, AbortController>()

type Emit = (channel: 'ask:delta' | 'ask:done', payload: unknown) => void

/** Start an ask; returns its id at once and reports through `emit`. */
export function startAsk(text: string, itemId: number | undefined, emit: Emit): { id: string } {
  const id = randomUUID()
  const ctl = new AbortController()
  inflight.set(id, ctl)
  void (async () => {
    // Let the invoke reply (carrying the id) reach the renderer before any event
    // does; an early failure would otherwise arrive for an id it does not know yet.
    await new Promise((r) => setImmediate(r))
    try {
      let prompt = text.trim()
      if (itemId !== undefined) {
        const item = getItem(itemId)
        if (item?.secret) throw new Error('Secret clips are never sent to a model')
        if (item && item.kind !== 'image') {
          prompt = `${prompt}\n\n<clip>\n${item.content.slice(0, MAX_CLIP_CHARS)}\n</clip>`
        }
      }
      const answer = await complete('transforms', { system: ASK_SYSTEM, prompt, maxTokens: 4000 })
      if (ctl.signal.aborted) return
      emit('ask:delta', { id, text: answer })
      emit('ask:done', { id, text: answer })
    } catch (err) {
      if (ctl.signal.aborted) return
      emit('ask:done', { id, error: err instanceof Error ? err.message : String(err) })
    } finally {
      inflight.delete(id)
    }
  })()
  return { id }
}

export function cancelAsk(id: string): void {
  inflight.get(id)?.abort()
  inflight.delete(id)
}

/** Rewrite `text` per `instruction` (empty = fix typos). */
export async function rewriteText(text: string, instruction?: string): Promise<string> {
  const how = instruction?.trim() || FIX_TYPOS
  const out = await complete('transforms', {
    system: REWRITE_SYSTEM,
    prompt: `Instruction: ${how}\n\nTEXT:\n${text}`,
    maxTokens: 4000
  })
  return out.trim()
}
