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
  /** Called with the sandbox id the instant it exists, BEFORE the long
   *  bootstrap — so the caller can record it and a later sweep can kill an
   *  orphan if the app dies mid-launch. */
  onSandbox?: (sandboxId: string) => void
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
  opts.onSandbox?.(sb.sandboxId) // record NOW, so a failed bootstrap can't orphan it
  console.log(`[e2b] sandbox ${sb.sandboxId} created in ${Date.now() - t0}ms; bootstrapping…`)
  try {
    await bootstrap(sb)
    await installBridge(sb)
    await installPlugin(sb)
    await seedClaudeConfig(sb, anthropicKey)
    console.log(`[e2b] ${sb.sandboxId} ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`)

    // Secrets and env go into a chmod-600 launch script written through the
    // files API — NEVER into the tmux command string. A `-e SECRET=...` flag
    // would ride E2B's control-plane request log and show in the sandbox
    // process list; the script keeps the token out of both. tmux -e is used
    // only for the launch script to inherit nothing but what we export.
    const env: Record<string, string> = {
      ...opts.env,
      CLIPMD_REMOTE: '1',
      CLIPMD_BRIDGE_PORT: String(BRIDGE_PORT),
      CLIPMD_HOOK_NODE: 'node',
      ...(oauth ? { CLAUDE_CODE_OAUTH_TOKEN: oauth } : { ANTHROPIC_API_KEY: anthropicKey! })
    }
    const exports = Object.entries(env)
      .map(([k, v]) => `export ${k}=${shellQuote(v)}`)
      .join('\n')
    const script = `#!/bin/sh\n${exports}\nexec claude ${opts.claudeArgs.map(shellQuote).join(' ')}\n`
    const scriptPath = `${WORKDIR}/launch-${opts.key}.sh`
    await sb.files.write(scriptPath, script)
    await run(sb, `chmod 600 ${scriptPath}`, 10_000)
    await run(
      sb,
      `mkdir -p ${shellQuote(opts.cwd)} && tmux new-session -d -s ${opts.key} -c ${shellQuote(opts.cwd)} sh ${scriptPath}`,
      30_000
    )
    return { sandboxId: sb.sandboxId, bridgeUrl: `https://${sb.getHost(BRIDGE_PORT)}` }
  } catch (err) {
    // A half-provisioned sandbox is a billing leak — kill it before rethrowing.
    console.error(`[e2b] launch failed for ${sb.sandboxId}; killing it:`, err)
    try {
      await sb.kill()
    } catch {
      /* already gone */
    }
    sandboxes.delete(sb.sandboxId)
    throw err
  }
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/**
 * Screen contents of the session's tmux pane, for menu-driving.
 *  - a string is the pane
 *  - '' (empty) is a TRANSIENT failure: the caller should keep waiting, not
 *    conclude the pane is gone (a single API blip must not abandon a session
 *    mid-boot, wedged on the trust menu)
 *  - null means the tmux session genuinely no longer exists
 */
export async function captureRemote(sandboxId: string, key: string): Promise<string | null> {
  try {
    const sb = await connect(sandboxId)
    const r = await sb.commands.run(`tmux capture-pane -p -t ${key}`, { timeoutMs: 15_000 })
    if (r.exitCode === 0) return r.stdout
    // Non-zero with "can't find session" is a real gone-pane; anything else transient.
    return /can't find|no server|no session/i.test(r.stderr) ? null : ''
  } catch {
    return '' // network/timeout — transient, keep waiting
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

/**
 * The set of currently-running sandbox ids, or null if the list call failed
 * (never treat a failed list as "everything is dead"). One API call for the
 * whole reconcile, versus a connect per session.
 */
export async function listRunningSandboxIds(): Promise<Set<string> | null> {
  try {
    const list = await SandboxCls().list({ apiKey: apiKey() })
    // The SDK returns an iterable of running-sandbox info; id field name has
    // varied across versions, so accept either.
    const ids = new Set<string>()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const s of list as any) {
      const id = s?.sandboxId ?? s?.sandbox_id ?? s?.id
      if (id) ids.add(String(id))
    }
    return ids
  } catch (err) {
    console.error('[e2b] could not list sandboxes:', err)
    return null
  }
}
