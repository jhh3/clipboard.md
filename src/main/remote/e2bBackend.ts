import { readFileSync } from 'fs'
import { join } from 'path'
import { createRequire } from 'module'
import type { Sandbox } from 'e2b'
import { getSettings } from '../settings'

/**
 * The SDK loads lazily via CJS require, NEVER as a static ESM import: inlining
 * its ESM build into the main bundle froze the app at startup — the main thread
 * parked forever in module-evaluation microtasks (a top-level await deep in the
 * SDK that never settles under Electron's main process; observed via `sample`,
 * zero log lines ever written). The CJS entry loads instantly and only when a
 * remote session is actually requested.
 */
const requireCjs = createRequire(import.meta.url)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sdkCache: any = null
function SandboxCls(): typeof Sandbox {
  if (!sdkCache) sdkCache = requireCjs('e2b')
  return sdkCache.Sandbox
}

/**
 * E2B session backend: the agent's claude process runs in a Firecracker microVM
 * instead of local tmux. Everything here was proven live before it was written
 * (probe, 2026-08-09): sandbox create 283ms; tmux + claude bootstrap ~10s once;
 * chat-ready in ~4.3s with a pre-seeded ~/.claude.json (no onboarding wizard,
 * no API-key approval dialog); the bridge's fixed port reachable over the
 * sandbox's public HTTPS host.
 *
 * Topology inversion vs local: there is no SQLite and no discovery file the app
 * can read inside the sandbox. So the bridge listens on a FIXED port
 * (CLIPMD_BRIDGE_PORT) bound to 0.0.0.0, the app derives the public URL from
 * the sandbox id, writes the discovery file LOCALLY itself ({url, token}), and
 * drains the bridge's in-memory outbox over GET /outbox into its own SQLite
 * (see outbox drain in agents.ts). The Stop hook posts replies to the bridge's
 * loopback /mirror. docs/REMOTE-AGENTS.md is the design; this is its R1.
 *
 * Auth: CLAUDE_CODE_OAUTH_TOKEN from Settings (subscription lane, minted by the
 * user with `claude setup-token`) when present, else the local ANTHROPIC_API_KEY
 * environment. The token/key travels only in the sandbox process environment —
 * never written to the sandbox filesystem, never logged.
 */

export const BRIDGE_PORT = 49500
const WORKDIR = '/home/user/clipmd'
/** Sandboxes auto-kill at this timeout; sends extend it (see touchSandbox). */
const SANDBOX_TTL_MS = 6 * 60 * 60 * 1000

function apiKey(): string {
  const key = getSettings().remote.e2bApiKey || process.env.E2B_API_KEY
  if (!key) throw new Error('E2B API key not set (Settings → Agents → Remote execution)')
  return key
}

/** Connected-sandbox cache; reconnecting by id is cheap but not free. */
const sandboxes = new Map<string, Sandbox>()

async function connect(sandboxId: string): Promise<Sandbox> {
  const cached = sandboxes.get(sandboxId)
  if (cached) return cached
  const sb = await SandboxCls().connect(sandboxId, { apiKey: apiKey() })
  sandboxes.set(sandboxId, sb)
  return sb
}

async function run(sb: Sandbox, cmd: string, timeoutMs = 60_000): Promise<string> {
  const r = await sb.commands.run(cmd, { timeoutMs })
  return (r.stdout + r.stderr).trim()
}

/**
 * Idempotent sandbox bootstrap. First run ~15-20s (apt + npm installs); reruns
 * are guarded to near-instant. A baked template would remove this cost entirely
 * (REMOTE-AGENTS.md R2) — for R1, honesty in the logs beats infra.
 */
async function bootstrap(sb: Sandbox): Promise<void> {
  await run(sb, 'command -v tmux >/dev/null || sudo apt-get install -y -qq tmux', 180_000)
  await run(sb, 'command -v claude >/dev/null || sudo npm i -g @anthropic-ai/claude-code', 300_000)
  // The bridge's one external dependency; installed beside it, not globally.
  await run(
    sb,
    `mkdir -p ${WORKDIR} && cd ${WORKDIR} && [ -d node_modules/@modelcontextprotocol ] || npm i --no-audit --no-fund @modelcontextprotocol/sdk`,
    300_000
  )
}

/**
 * The bundled bridge travels as files: bridge.mjs plus every ./chunks/*.mjs it
 * (transitively) imports — the build splits shared modules (fts, the rolldown
 * runtime) into hashed chunks, and shipping only the entry left the remote
 * bridge dying on ERR_MODULE_NOT_FOUND (observed live). Resolved by scanning
 * imports rather than hardcoding names, so hash changes can't break it. Bare
 * imports (the MCP SDK) resolve from WORKDIR/node_modules via bootstrap().
 */
async function installBridge(sb: Sandbox): Promise<void> {
  const uploaded = new Set<string>()
  const uploadWithChunks = async (rel: string): Promise<void> => {
    if (uploaded.has(rel)) return
    uploaded.add(rel)
    const content = readFileSync(join(__dirname, rel), 'utf8')
    await sb.files.write(`${WORKDIR}/${rel}`, content)
    for (const m of content.matchAll(/["']\.{1,2}\/(chunks\/[\w.-]+\.mjs)["']/g)) {
      await uploadWithChunks(m[1])
    }
  }
  await uploadWithChunks('bridge.mjs')
}

/** Plugin scaffold inside the sandbox + registration via the sandbox's claude. */
async function installPlugin(sb: Sandbox): Promise<void> {
  const src = pluginSourceRoot()
  const files: Array<[string, string]> = [
    ['.claude-plugin/marketplace.json', readFileSync(join(src, '.claude-plugin', 'marketplace.json'), 'utf8')],
    [
      'plugins/clipmd-bridge/.claude-plugin/plugin.json',
      readFileSync(join(src, 'plugins', 'clipmd-bridge', '.claude-plugin', 'plugin.json'), 'utf8')
    ],
    [
      'plugins/clipmd-bridge/hooks/hooks.json',
      readFileSync(join(src, 'plugins', 'clipmd-bridge', 'hooks', 'hooks.json'), 'utf8')
    ],
    [
      'plugins/clipmd-bridge/hooks/mirror-turn.mjs',
      readFileSync(join(src, 'plugins', 'clipmd-bridge', 'hooks', 'mirror-turn.mjs'), 'utf8')
    ],
    [
      'plugins/clipmd-bridge/.mcp.json',
      JSON.stringify({
        mcpServers: { 'clipmd-bridge': { command: 'node', args: [`${WORKDIR}/bridge.mjs`] } }
      })
    ]
  ]
  for (const [rel, content] of files) {
    await sb.files.write(`${WORKDIR}/plugin/${rel}`, content)
  }
  await run(sb, `claude plugin marketplace add ${WORKDIR}/plugin || true`, 60_000)
  await run(sb, 'claude plugin marketplace update clipboard-md || true', 60_000)
  await run(sb, 'claude plugin install clipmd-bridge@clipboard-md || true', 60_000)
  await run(sb, 'claude plugin update clipmd-bridge@clipboard-md || true', 60_000)
}

function pluginSourceRoot(): string {
  for (const p of [
    join(process.resourcesPath ?? '', 'plugin'),
    join(__dirname, '..', '..', 'resources', 'plugin')
  ]) {
    try {
      readFileSync(join(p, '.claude-plugin', 'marketplace.json'))
      return p
    } catch {
      /* try next */
    }
  }
  throw new Error('plugin scaffold not found')
}

/**
 * Pre-seed claude's config so it boots straight to chat. Without this the fresh
 * home directory runs the onboarding wizard (theme picker) and, with an API key
 * in the environment, stops on an approval dialog — both observed live, both
 * invisible to our menu-driving regexes.
 */
async function seedClaudeConfig(sb: Sandbox, anthropicKey: string | null): Promise<void> {
  const cfg: Record<string, unknown> = {
    hasCompletedOnboarding: true,
    theme: 'dark',
    bypassPermissionsModeAccepted: true
  }
  if (anthropicKey) {
    cfg.customApiKeyResponses = { approved: [anthropicKey.slice(-20)], rejected: [] }
  }
  await sb.files.write('/home/user/.claude.json', JSON.stringify(cfg))
}

export interface RemoteSession {
  sandboxId: string
  /** Public base URL of the bridge, e.g. https://49500-<id>.e2b.app */
  bridgeUrl: string
}

export interface RemoteLaunchOptions {
  key: string
  cwd: string
  claudeArgs: string[]
  /** CLIPMD_* env for the session (no DB/memory/require paths — remote mode). */
  env: Record<string, string>
}

/** Create a sandbox, make it a claude host, and start the session in tmux. */
export async function launchRemote(opts: RemoteLaunchOptions): Promise<RemoteSession> {
  const remote = getSettings().remote
  const oauth = remote.claudeOauthToken || null
  const anthropicKey = oauth ? null : (process.env.ANTHROPIC_API_KEY ?? null)
  if (!oauth && !anthropicKey) {
    throw new Error(
      'Remote sessions need auth: paste a `claude setup-token` in Settings → Agents → Remote execution, or export ANTHROPIC_API_KEY'
    )
  }

  const t0 = Date.now()
  const sb = await SandboxCls().create('base', { apiKey: apiKey(), timeoutMs: SANDBOX_TTL_MS })
  sandboxes.set(sb.sandboxId, sb)
  console.log(`[e2b] sandbox ${sb.sandboxId} created in ${Date.now() - t0}ms; bootstrapping…`)
  await bootstrap(sb)
  await installBridge(sb)
  await installPlugin(sb)
  await seedClaudeConfig(sb, anthropicKey)
  console.log(`[e2b] ${sb.sandboxId} ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`)

  const env: Record<string, string> = {
    ...opts.env,
    CLIPMD_BRIDGE_PORT: String(BRIDGE_PORT),
    CLIPMD_HOOK_NODE: 'node',
    ...(oauth ? { CLAUDE_CODE_OAUTH_TOKEN: oauth } : { ANTHROPIC_API_KEY: anthropicKey! })
  }
  // The claude invocation goes through a launch script rather than inline shell:
  // args contain prompts with arbitrary quoting, and nesting them inside the
  // tmux command string is exactly how quoting bugs are made.
  const script = `#!/bin/sh\nexec claude ${opts.claudeArgs.map(shellQuote).join(' ')}\n`
  await sb.files.write(`${WORKDIR}/launch-${opts.key}.sh`, script)
  const envFlags = Object.entries(env)
    .map(([k, v]) => `-e ${shellQuote(`${k}=${v}`)}`)
    .join(' ')
  await run(
    sb,
    `mkdir -p ${shellQuote(opts.cwd)} && tmux new-session -d -s ${opts.key} -c ${shellQuote(opts.cwd)} ${envFlags} sh ${WORKDIR}/launch-${opts.key}.sh`,
    30_000
  )
  return { sandboxId: sb.sandboxId, bridgeUrl: `https://${sb.getHost(BRIDGE_PORT)}` }
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** Screen contents of the session's tmux pane, for menu-driving. */
export async function captureRemote(sandboxId: string, key: string): Promise<string | null> {
  try {
    const sb = await connect(sandboxId)
    const r = await sb.commands.run(`tmux capture-pane -p -t ${key}`, { timeoutMs: 15_000 })
    return r.exitCode === 0 ? r.stdout : null
  } catch {
    return null
  }
}

export async function sendKeysRemote(sandboxId: string, key: string, keys: string[]): Promise<void> {
  try {
    const sb = await connect(sandboxId)
    await sb.commands.run(`tmux send-keys -t ${key} ${keys.map(shellQuote).join(' ')}`, {
      timeoutMs: 15_000
    })
  } catch {
    /* menu-driving is best-effort */
  }
}

/** Kill the sandbox outright — the whole VM, not just the session. */
export async function killRemote(sandboxId: string): Promise<void> {
  try {
    const sb = await connect(sandboxId)
    await sb.kill()
  } catch (err) {
    console.error(`[e2b] could not kill ${sandboxId}:`, err)
  } finally {
    sandboxes.delete(sandboxId)
  }
}

/** Keep an active session's sandbox from hitting its TTL mid-conversation. */
export async function touchSandbox(sandboxId: string): Promise<void> {
  try {
    const sb = await connect(sandboxId)
    await sb.setTimeout(SANDBOX_TTL_MS)
  } catch {
    /* best-effort */
  }
}
