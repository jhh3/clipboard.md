import { app } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

const execFileP = promisify(execFile)

/**
 * Install the bridge as a Claude Code PLUGIN.
 *
 * This is not decoration. `notifications/claude/channel` — the only way to speak into
 * a live session — is honoured for CHANNELS, and a channel comes from a plugin loaded
 * with `--dangerously-load-development-channels`. Registering the same server via
 * `--mcp-config` gives you working tools and a channel that is silently ignored:
 * verified against a live session, idle and mid-turn, which took no notice at all.
 *
 * Structure copied from Nullframe/mobot: a local-directory marketplace holding one
 * plugin, whose `.mcp.json` declares the server.
 *
 *   <userData>/plugin/.claude-plugin/marketplace.json
 *   <userData>/plugin/plugins/clipmd-bridge/.claude-plugin/plugin.json
 *   <userData>/plugin/plugins/clipmd-bridge/.mcp.json
 *   <userData>/plugin/plugins/clipmd-bridge/bridge.mjs
 *
 * It is materialised into userData rather than run from inside the app bundle because
 * the bridge lives in app.asar, which is a file — claude has to spawn a real path.
 *
 * Per-session values (which session, which database) cannot live in the plugin's
 * `.mcp.json`, since one plugin serves every session. They are injected into the tmux
 * session's environment instead (`tmux new-session -e`), and the MCP server inherits
 * them through claude. Same trick mobot uses.
 */

export const MARKETPLACE = 'clipboard-md'
export const PLUGIN = 'clipmd-bridge'
/** What the --dangerously-load-development-channels flag wants. */
export const CHANNEL_REF = `plugin:${PLUGIN}@${MARKETPLACE}`

/**
 * Environment the Stop hook needs. It runs in claude's process tree, not ours, so
 * everything it depends on has to be handed to it: a node binary, and somewhere to
 * resolve better-sqlite3 from — there is no node_modules beside a plugin.
 */
export function hookEnv(): Record<string, string> {
  return {
    CLIPMD_HOOK_NODE: process.execPath,
    // createRequire() resolves relative to this file's location.
    CLIPMD_REQUIRE_FROM: join(__dirname, 'index.mjs')
  }
}

export function pluginRoot(): string {
  return join(app.getPath('userData'), 'plugin')
}

function pluginDir(): string {
  return join(pluginRoot(), 'plugins', PLUGIN)
}

/** Where the scaffold ships: extraResources in a packaged build, the repo in dev. */
function sourceRoot(): string | null {
  for (const p of [
    join(process.resourcesPath ?? '', 'plugin'),
    join(__dirname, '..', '..', 'resources', 'plugin')
  ]) {
    if (existsSync(join(p, '.claude-plugin', 'marketplace.json'))) return p
  }
  return null
}

/**
 * Write the plugin tree, then register and install it. Idempotent — safe on every
 * launch, and it re-copies so a new build's bridge replaces the cached one.
 */
export async function ensurePlugin(): Promise<boolean> {
  const src = sourceRoot()
  if (!src) {
    console.error('[plugin] scaffold not found; agent sessions will have no channel')
    return false
  }
  const bridge = join(__dirname, 'bridge.mjs')
  if (!existsSync(bridge)) {
    console.error('[plugin] bridge.mjs not found next to the main bundle')
    return false
  }

  try {
    mkdirSync(join(pluginDir(), '.claude-plugin'), { recursive: true })
    mkdirSync(join(pluginRoot(), '.claude-plugin'), { recursive: true })
    copyFileSync(
      join(src, '.claude-plugin', 'marketplace.json'),
      join(pluginRoot(), '.claude-plugin', 'marketplace.json')
    )
    copyFileSync(
      join(src, 'plugins', PLUGIN, '.claude-plugin', 'plugin.json'),
      join(pluginDir(), '.claude-plugin', 'plugin.json')
    )
    // Hooks DO get copied — they are dependency-free scripts claude runs directly.
    mkdirSync(join(pluginDir(), 'hooks'), { recursive: true })
    for (const f of ['hooks.json', 'mirror-turn.mjs']) {
      copyFileSync(join(src, 'plugins', PLUGIN, 'hooks', f), join(pluginDir(), 'hooks', f))
    }

    // The bridge is NOT copied here. It is an ESM bundle with externalised
    // dependencies (the MCP SDK, better-sqlite3), so away from the app's
    // node_modules its imports fail with ERR_MODULE_NOT_FOUND and claude drops the
    // server with "Connection closed" — observed exactly that. Run it in place
    // instead; Electron-as-node resolves paths inside app.asar fine, which we
    // verified separately.

    // ELECTRON_RUN_AS_NODE makes our own binary behave as plain node, which is the
    // only Node we can be certain exists on the user's machine.
    writeFileSync(
      join(pluginDir(), '.mcp.json'),
      JSON.stringify(
        {
          mcpServers: {
            [PLUGIN]: {
              command: process.execPath,
              args: [bridge],
              env: { ELECTRON_RUN_AS_NODE: '1' }
            }
          }
        },
        null,
        2
      )
    )
  } catch (err) {
    console.error('[plugin] could not materialise the plugin tree:', err)
    return false
  }

  // Registering and installing are separately idempotent; "already exists" is a
  // success here, so neither is allowed to throw.
  await run(['plugin', 'marketplace', 'add', pluginRoot()])
  await run(['plugin', 'marketplace', 'update', MARKETPLACE])
  await run(['plugin', 'install', `${PLUGIN}@${MARKETPLACE}`])
  // `install` is a no-op once the plugin exists, and the cache is keyed by VERSION —
  // so a plugin.json version bump alone leaves the old copy in place and the install
  // looks successful while changing nothing. Observed exactly that: hooks were added
  // and the cache stayed on 0.1.0. `update` is what actually pulls the new version.
  await run(['plugin', 'update', `${PLUGIN}@${MARKETPLACE}`])

  const ok = await installed()
  console.log(
    ok
      ? `[plugin] ${CHANNEL_REF} installed; sessions get a two-way channel`
      : `[plugin] ${CHANNEL_REF} did NOT install — sessions will have tools but no channel`
  )
  return ok
}

async function run(args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileP('claude', args, { timeout: 60_000 })
    return stdout
  } catch (err) {
    // Expected on re-run ("already added"), so this is informational, not an error.
    console.log(`[plugin] claude ${args.slice(0, 3).join(' ')}: ${(err as Error).message.split('\n')[0]}`)
    return null
  }
}

async function installed(): Promise<boolean> {
  const out = await run(['plugin', 'list'])
  if (out) return out.includes(PLUGIN)
  // `plugin list` output is not a contract; fall back to the cache on disk.
  const cache = join(app.getPath('home'), '.claude', 'plugins')
  try {
    return readFileSync(join(cache, 'config.json'), 'utf8').includes(PLUGIN)
  } catch {
    return false
  }
}
