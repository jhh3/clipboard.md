import { access } from 'fs/promises'
import { constants } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { PortRequest } from './index'
import { getSettings } from '../settings'
import { resolveVendoredCli, agentScratchDir } from './nativeCli'

/**
 * Subscription lane #1: Claude Agent SDK, riding the user's existing Claude Code
 * login (~/.claude/.credentials.json). Typed programmatic access — no CLI string
 * parsing, no OAuth token scraping.
 *
 * Vision: the SDK runs an agent, so image inputs work by allowing the Read tool
 * and referencing the file path in the prompt.
 */

export async function claudeAgentAvailable(): Promise<{ ok: boolean; detail: string }> {
  try {
    await access(join(homedir(), '.claude', '.credentials.json'), constants.R_OK)
    return { ok: true, detail: 'Claude subscription (Agent SDK)' }
  } catch {
    if (process.env.ANTHROPIC_API_KEY) return { ok: true, detail: 'Agent SDK via ANTHROPIC_API_KEY' }
    return { ok: false, detail: 'no Claude login or ANTHROPIC_API_KEY — run `claude` once to log in' }
  }
}

export async function claudeAgentComplete(req: PortRequest): Promise<string> {
  const { query } = await import('@anthropic-ai/claude-agent-sdk')

  const prompt = req.imagePath
    ? `${req.prompt}\n\nThe image to analyze is at: ${req.imagePath} — Read it first.`
    : req.prompt

  // In a packaged build the SDK would derive this from its own location inside
  // app.asar and spawn would fail with ENOTDIR; undefined in dev leaves its own
  // (correct) resolution alone.
  const pathToClaudeCodeExecutable = resolveVendoredCli('@anthropic-ai/claude-agent-sdk', 'claude')

  const q = query({
    prompt,
    options: {
      ...(pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable } : {}),
      // Keep the agent out of the user's files: an empty scratch dir, and none of the
      // ambient CLAUDE.md/settings discovery that walking a real project implies.
      // Without this it inherits our TCC identity and triggers folder-access prompts
      // for work that only ever needs the text in the prompt.
      cwd: agentScratchDir(),
      settingSources: [],
      // Fast by default: haiku unless the user picks otherwise in Settings.
      model: getSettings().models['claude-agent'] ?? 'haiku',
      systemPrompt:
        (req.system ? req.system + '\n\n' : '') +
        'You are a silent text-processing engine inside a clipboard manager. Return ONLY the requested output — no preamble, no commentary.' +
        (req.json ? ' Output must be a single valid JSON object.' : ''),
      allowedTools: req.imagePath ? ['Read'] : [],
      maxTurns: req.imagePath ? 3 : 1,
      permissionMode: 'bypassPermissions'
    }
  })

  for await (const message of q) {
    if (message.type === 'result') {
      if (message.subtype === 'success') return message.result
      throw new Error(`agent sdk: ${message.subtype}`)
    }
  }
  throw new Error('agent sdk: no result message')
}
