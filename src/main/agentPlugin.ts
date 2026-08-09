import { app } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { claudeBin } from './claudeBin'

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
    // Under an AppImage, process.execPath points inside the ephemeral FUSE mount
    // (/tmp/.mount_XXXX/...), which disappears when the app exits or is relaunched —
    // so a session outliving one app run would invoke a node that no longer exists
    // and the hook would fail for OUR sessions too. APPIMAGE is the stable path, and
    // it honours ELECTRON_RUN_AS_NODE (set alongside this in sessionEnv).
    CLIPMD_HOOK_NODE: process.env.APPIMAGE ?? process.execPath,
    // createRequire() resolves relative to this file's location.
    CLIPMD_REQUIRE_FROM: join(__dirname, 'index.mjs')
  }
}

/**
 * The stable, always-present path to this app's binary.
 *
 * Anything we register with an agent outlives the process that registered it, so the
 * command has to keep working across restarts and upgrades. process.execPath does not
 * under an AppImage — it points into the ephemeral /tmp/.mount_XXXX — and in a dev
 * checkout it moves whenever the pnpm store changes.
 */
function stableBinary(): string {
  return process.env.APPIMAGE ?? process.execPath
}

/**
 * Register the clipboard MCP server with Claude Code, so installing the app is all a
 * user has to do to give their agents clipboard search.
 *
 * `mcp add` fails when the name is already registered, which is the normal case on
 * every launch after the first — so a failure here is information, not an error.
 */
export async function ensureMcpServer(): Promise<void> {
  const bin = stableBinary()
  // --scope user: available in every project, not just whichever directory the app
  // happened to be launched from.
  const out = await run(['mcp', 'add', '--scope', 'user', 'clipboard', '--', bin, '--mcp'])
  if (out !== null) console.log('[mcp] registered "clipboard" with Claude Code')
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

    // Registered as `<app binary> --bridge`, not as a script path.
    //
    // This file is written once and read by claude for as long as the plugin is
    // installed, so every path in it has to outlive the process that wrote it.
    // process.execPath and the bridge.mjs path both point inside the AppImage's
    // ephemeral /tmp/.mount_XXXX, which is gone after the next restart — observed
    // exactly that: `claude mcp list` showed the bridge on a mount path that no
    // longer existed. The installed binary is the one stable address, and it knows
    // how to run the bridge itself.
    writeFileSync(
      join(pluginDir(), '.mcp.json'),
      JSON.stringify(
        { mcpServers: { [PLUGIN]: { command: stableBinary(), args: ['--bridge'] } } },
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
    const { stdout } = await execFileP(claudeBin(), args, { timeout: 60_000 })
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
