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
import { join } from 'path'
import { existsSync } from 'fs'
import { openReadOnlyDb } from '../main/store/db'
import { searchKeyword, getItem, sessionsList } from '../main/store/items'
import { MACOS } from '../main/platform'

function dataDir(): string {
  // Electron userData for productName "clipboard.md" per platform.
  if (MACOS)
    return join(homedir(), 'Library', 'Application Support', 'clipboard.md', 'data')
  return join(homedir(), '.config', 'clipboard.md', 'data')
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

function systemCopy(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const cmd =
      MACOS
        ? ['pbcopy']
        : process.env.WAYLAND_DISPLAY && !process.env.CLIPMD_FORCE_XCLIP
          ? ['wl-copy']
          : ['xclip', '-selection', 'clipboard', '-i']
    const child = execFile(cmd[0], cmd.slice(1), (err) => (err ? reject(err) : resolve()))
    child.stdin?.end(text)
  })
}

void main()
