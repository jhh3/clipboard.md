import { execFile } from 'child_process'
import { promisify } from 'util'
import { access } from 'fs/promises'
import { constants } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { PortRequest } from './index'
import { getSettings } from '../settings'
import { resolveVendoredCli, agentScratchDir } from './nativeCli'
import { MACOS } from '../platform'

const execFileP = promisify(execFile)

/**
 * Subscription lane #1: Claude Agent SDK, riding the user's existing Claude Code
 * login (~/.claude/.credentials.json). Typed programmatic access — no CLI string
 * parsing, no OAuth token scraping.
 *
 * Vision: the SDK runs an agent, so image inputs work by allowing the Read tool
 * and referencing the file path in the prompt.
 */

/** Linux, WSL, and macOS with Keychain storage disabled keep the login on disk. */
async function credentialsFilePresent(): Promise<boolean> {
  try {
    await access(join(homedir(), '.claude', '.credentials.json'), constants.R_OK)
    return true
  } catch {
    return false
  }
}

/**
 * macOS keeps the Claude Code login in the login Keychain, not on disk.
 *
 * Checking only for ~/.claude/.credentials.json reported "no Claude login" to every
 * macOS subscription user — the file simply does not exist there — while the CLI we
 * spawn reads the Keychain itself and would have worked fine. A false negative here
 * is not cosmetic: complete() skips providers it believes are unavailable, so the
 * whole subscription lane went dark.
 *
 * Attributes only, never the secret. Adding -w reads the password, which requires ACL
 * authorization and pops a "clipboard.md wants to use your confidential information"
 * dialog on every status refresh. Presence is all we need — the CLI refreshes the
 * token itself, so checking expiry here could only invent new false negatives.
 */
async function keychainLoginPresent(): Promise<boolean> {
  if (!MACOS) return false
  try {
    await execFileP('/usr/bin/security', ['find-generic-password', '-s', 'Claude Code-credentials'], {
      timeout: 5000
    })
    return true
  } catch {
    return false
  }
}

export async function claudeAgentAvailable(): Promise<{ ok: boolean; detail: string }> {
  if (await credentialsFilePresent()) return { ok: true, detail: 'Claude subscription (Agent SDK)' }
  if (await keychainLoginPresent()) return { ok: true, detail: 'Claude subscription (Keychain)' }
  if (process.env.ANTHROPIC_API_KEY) return { ok: true, detail: 'Agent SDK via ANTHROPIC_API_KEY' }
  return { ok: false, detail: 'no Claude login or ANTHROPIC_API_KEY — run `claude` once to log in' }
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
