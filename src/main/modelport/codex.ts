import { access } from 'fs/promises'
import { constants } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { PortRequest } from './index'
import { resolveVendoredCli, agentScratchDir } from './nativeCli'

/**
 * Subscription lane #2: Codex SDK riding the user's ChatGPT-plan Codex login
 * (~/.codex/auth.json).
 */

/**
 * A thread per request. Reusing one thread for the app's lifetime meant every
 * clip's text accumulated in a single conversation: unbounded token cost,
 * cross-contamination between unrelated clips, and eventual hard failure at the
 * context limit with no recovery path.
 */

export async function codexAvailable(): Promise<{ ok: boolean; detail: string }> {
  try {
    await access(join(homedir(), '.codex', 'auth.json'), constants.R_OK)
    return { ok: true, detail: 'Codex subscription (Codex SDK)' }
  } catch {
    if (process.env.OPENAI_API_KEY) return { ok: true, detail: 'Codex SDK via OPENAI_API_KEY' }
    return { ok: false, detail: 'no Codex login or OPENAI_API_KEY — run `codex` once to log in' }
  }
}

async function newThread(): Promise<import('@openai/codex-sdk').Thread> {
  const { Codex } = await import('@openai/codex-sdk')
  // Same asar problem as the Claude lane: the SDK would spawn a path inside
  // app.asar and get ENOTDIR. Undefined in dev leaves its own resolution alone.
  const codexPathOverride = resolveVendoredCli('@openai/codex', 'codex')
  const codex = new Codex(codexPathOverride ? { codexPathOverride } : {})
  // workingDirectory for the same reason as the Claude lane: a coding agent pointed at
  // an interesting directory inherits our TCC identity and makes macOS ask the user
  // for folder access on our behalf. Enrichment only ever needs the prompt text.
  return codex.startThread({
    sandboxMode: 'read-only',
    skipGitRepoCheck: true,
    workingDirectory: agentScratchDir()
  })
}

export async function codexComplete(req: PortRequest): Promise<string> {
  const thread = await newThread()
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
