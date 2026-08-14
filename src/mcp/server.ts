/**
 * clipboard.md MCP server (stdio) — lets local agent sessions (Claude Code, Codex,
 * anything MCP) search and use your clipboard history.
 *
 * Runs as a plain Node process, independent of the Electron app: reads the same
 * SQLite file directly (WAL mode makes concurrent readers safe). Clipboard writes
 * shell out to wl-copy/xclip/pbcopy so they work without the app running too.
 *
 * Register:  claude mcp add clipboard -- node <repo>/out/main/mcp.mjs
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { execFile } from 'child_process'
import { homedir } from 'os'
import { join, posix, win32 } from 'path'
import { existsSync } from 'fs'
import { openReadOnlyDb } from '../main/store/db'
import { searchKeyword, getItem, sessionsList } from '../main/store/items'
import { currentPlatform, type Platform } from '../main/platform'

/**
 * Where the running app keeps its database.
 *
 * This MUST agree with Electron's `app.getPath('userData')` for productName
 * "clipboard.md" on each platform, and it is a separate process so nothing checks
 * that it does. A wrong answer is not an error: the file is simply absent, and the
 * server exits telling the user to "run the app once first" — on a machine where
 * they have been running it for weeks.
 *
 * Pure over (platform, home, env) so all three can be asserted from any one of them.
 */
export function dataDir(
  platform: Platform = currentPlatform(),
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env
): string {
  // The target platform's join, not the running one's: this is pure so it can be
  // asserted for all three from any one of them, and a bare join would emit
  // `C:\\Users\\Ada/clipboard.md` when the test runs on Linux.
  if (platform === 'darwin') return posix.join(home, 'Library', 'Application Support', 'clipboard.md', 'data')
  // Electron uses %APPDATA% (Roaming), not LOCALAPPDATA, and not ~/.config — which
  // is where the previous `else` branch sent Windows, so the server looked for the
  // database in a directory nothing ever creates.
  if (platform === 'win32')
    return win32.join(env.APPDATA ?? win32.join(home, 'AppData', 'Roaming'), 'clipboard.md', 'data')
  return posix.join(home, '.config', 'clipboard.md', 'data')
}

function itemSummary(i: NonNullable<ReturnType<typeof getItem>>): Record<string, unknown> {
  return {
    id: i.id,
    kind: i.kind,
    title: i.autoTitle ?? null,
    preview: i.secret ? '[concealed secret]' : i.preview,
    tags: i.tags,
    contentClass: i.contentClass ?? null,
    sourceApp: i.sourceApp ?? null,
    copiedAt: new Date(i.lastCopiedAt).toISOString(),
    pinned: i.pinned
  }
}

async function main(): Promise<void> {
  const dir = dataDir()
  if (!existsSync(join(dir, 'clipboard.db'))) {
    console.error(`clipboard.md database not found at ${dir} — run the app once first.`)
    process.exit(1)
  }
  // Read-only, and deliberately NOT via openDb(): that runs migrations, and a
  // stale MCP binary racing the running app must never mutate its schema.
  openReadOnlyDb(dir)

  const server = new McpServer({ name: 'clipboard-md', version: '0.1.0' })

  server.tool(
    'clipboard_search',
    'Full-text search over the user clipboard history (titles, content, OCR text of images, tags). Returns matching clips, most relevant first.',
    { query: z.string(), kind: z.enum(['all', 'text', 'image', 'link', 'code', 'files']).optional(), limit: z.number().int().min(1).max(50).optional() },
    async ({ query, kind, limit }) => {
      const res = searchKeyword({ q: query, kind: kind === 'all' ? undefined : kind, limit: limit ?? 20 })
      return { content: [{ type: 'text', text: JSON.stringify(res.items.map(itemSummary), null, 1) }] }
    }
  )

  server.tool(
    'clipboard_recent',
    'Most recent clipboard items (newest first).',
    { limit: z.number().int().min(1).max(50).optional() },
    async ({ limit }) => {
      const res = searchKeyword({ q: '', limit: limit ?? 15 })
      return { content: [{ type: 'text', text: JSON.stringify(res.items.map(itemSummary), null, 1) }] }
    }
  )

  server.tool(
    'clipboard_get',
    'Fetch the FULL content of one clip by id (text clips return content; secret clips are refused; image clips return metadata + OCR text and the file path).',
    { id: z.number().int() },
    async ({ id }) => {
      const item = getItem(id)
      if (!item) return { content: [{ type: 'text', text: 'not found' }], isError: true }
      if (item.secret)
        return { content: [{ type: 'text', text: 'refused: item is flagged as a secret' }], isError: true }
      const payload =
        item.kind === 'image'
          ? { ...itemSummary(item), imagePath: item.content, ocrText: item.ocrText ?? null, description: item.description ?? null }
          : { ...itemSummary(item), content: item.content }
      return { content: [{ type: 'text', text: JSON.stringify(payload, null, 1) }] }
    }
  )

  server.tool(
    'clipboard_sessions',
    'List recent auto-clustered work sessions (time-grouped clipboard activity with AI titles).',
    {},
    async () => {
      const sessions = sessionsList().map((s) => ({
        id: s.id,
        title: s.title,
        started: new Date(s.startedAt).toISOString(),
        ended: new Date(s.endedAt).toISOString(),
        items: s.count
      }))
      return { content: [{ type: 'text', text: JSON.stringify(sessions, null, 1) }] }
    }
  )

  server.tool(
    'clipboard_copy',
    'Put text on the user system clipboard.',
    { text: z.string() },
    async ({ text }) => {
      await systemCopy(text)
      return { content: [{ type: 'text', text: 'copied' }] }
    }
  )

  const transport = new StdioServerTransport()
  await server.connect(transport)
}

/**
 * The command that takes text on stdin and puts it on the clipboard.
 *
 * Windows has no `xclip`, so the previous `else` sent it to one and every
 * `clipboard_copy` from an agent failed with ENOENT. PowerShell's Set-Clipboard is
 * the built-in equivalent; `-NoProfile` because a user's profile can print banners
 * (and take a second to do it) and `$input` reads the piped text without needing it
 * on the command line, where quoting would mangle it.
 */
export function copyCommand(platform: Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform === 'darwin') return ['pbcopy']
  if (platform === 'win32')
    return ['powershell', '-NoProfile', '-NonInteractive', '-Command', '$input | Set-Clipboard']
  return env.WAYLAND_DISPLAY && !env.CLIPMD_FORCE_XCLIP
    ? ['wl-copy']
    : ['xclip', '-selection', 'clipboard', '-i']
}

function systemCopy(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const cmd = copyCommand(currentPlatform(), process.env)
    const child = execFile(cmd[0], cmd.slice(1), (err) => (err ? reject(err) : resolve()))
    child.stdin?.end(text)
  })
}

// Only when this process was actually launched to BE the MCP server.
//
// This ran on import, so merely importing dataDir() from a unit test started a real
// server in the test process — and on a machine with no database it called
// process.exit(1) and took the whole test run down with it. That is what Windows CI
// caught: every test passed and the run still failed. The app always passes --mcp
// when it loads this bundle (src/main/index.ts startStdioServer), so the flag is the
// honest signal for "I am the server", and a test importing a helper is not.
if (process.argv.includes('--mcp')) void main()
