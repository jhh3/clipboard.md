import { access } from 'fs/promises'
import { constants } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { PortRequest } from './index'

/**
 * Subscription lane #2: Codex SDK riding the user's ChatGPT-plan Codex login
 * (~/.codex/auth.json).
 */

let threadPromise: Promise<import('@openai/codex-sdk').Thread> | null = null

export async function codexAvailable(): Promise<{ ok: boolean; detail: string }> {
  try {
    await access(join(homedir(), '.codex', 'auth.json'), constants.R_OK)
    return { ok: true, detail: 'Codex subscription (Codex SDK)' }
  } catch {
    if (process.env.OPENAI_API_KEY) return { ok: true, detail: 'Codex SDK via OPENAI_API_KEY' }
    return { ok: false, detail: 'no Codex login or OPENAI_API_KEY — run `codex` once to log in' }
  }
}

async function getThread(): Promise<import('@openai/codex-sdk').Thread> {
  if (!threadPromise) {
    threadPromise = (async () => {
      const { Codex } = await import('@openai/codex-sdk')
      const codex = new Codex()
      return codex.startThread({
        sandboxMode: 'read-only',
        skipGitRepoCheck: true
      })
    })()
  }
  return threadPromise
}

export async function codexComplete(req: PortRequest): Promise<string> {
  const thread = await getThread()
  const prompt =
    (req.system ? `[Instructions]\n${req.system}\n\n` : '') +
    'Return ONLY the requested output, no preamble.' +
    (req.json ? ' Output must be a single valid JSON object.' : '') +
    '\n\n' +
    req.prompt +
    (req.imagePath ? `\n\nAnalyze the image at: ${req.imagePath}` : '')
  const result = await thread.run(prompt)
  const text = result.finalResponse
  if (!text) throw new Error('codex sdk: empty response')
  return text
}
