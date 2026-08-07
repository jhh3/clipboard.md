import { z } from 'zod'
import { completeJson, complete } from './modelport'
import {
  nextEnrichQueueBatch,
  dequeueEnrichment,
  updateEnrichment,
  getItem
} from './store/items'
import { getDb } from './store/db'
import { getSettings } from './settings'

const CLASSES = [
  'code', 'link', 'error', 'address', 'contact', 'meeting',
  'prose', 'command', 'data', 'screenshot', 'photo', 'other'
] as const

const TextEnrichment = z.object({
  title: z.string().max(120),
  tags: z.array(z.string().max(32)).max(6),
  content_class: z.enum(CLASSES),
  language: z.string().max(24).nullish()
})

const ImageEnrichment = z.object({
  ocr_text: z.string().max(8000),
  description: z.string().max(600),
  tags: z.array(z.string().max(32)).max(6),
  content_class: z.enum(['screenshot', 'photo', 'other'])
})

const SESSION_GAP_MS = 20 * 60 * 1000

let running = false
let processed = 0
let lastError: string | undefined
let timer: ReturnType<typeof setInterval> | null = null
let notify: () => void = () => {}

export function startEnrichment(onChanged: () => void): void {
  notify = onChanged
  if (!timer) timer = setInterval(() => void drain(), 15_000)
  void drain()
}

export function stopEnrichment(): void {
  if (timer) clearInterval(timer)
  timer = null
}

export function enrichmentRunStats(): { processed: number; lastError?: string } {
  return { processed, lastError }
}

export async function drain(): Promise<void> {
  if (running) return
  const settings = getSettings()
  if (!settings.enrichment.enabled) return
  running = true
  try {
    for (;;) {
      const batch = nextEnrichQueueBatch(2)
      if (batch.length === 0) break
      for (const item of batch) {
        try {
          await enrichOne(item.id)
          dequeueEnrichment(item.id)
          processed++
          notify()
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          lastError = msg
          console.error(`[enrich] item ${item.id} failed:`, msg)
          dequeueEnrichment(item.id, msg)
        }
      }
    }
    if (getSettings().sessionsEnabled) await titleSessions()
  } finally {
    running = false
  }
}

async function enrichOne(id: number): Promise<void> {
  const item = getItem(id)
  if (!item || item.secret) return

  if (item.kind === 'image') {
    const out = await completeJson(
      'enrichment',
      {
        system: 'You index clipboard images for search.',
        prompt:
          'Analyze this image. Return JSON: {"ocr_text": string (ALL readable text, verbatim, empty string if none), "description": string (1-2 sentences), "tags": string[] (lowercase, ≤6), "content_class": "screenshot"|"photo"|"other"}',
        imagePath: item.content,
        maxTokens: 4000
      },
      ImageEnrichment
    )
    updateEnrichment(id, {
      autoTitle: out.description.slice(0, 120),
      tags: out.tags,
      contentClass: out.content_class,
      ocrText: out.ocr_text,
      description: out.description
    })
    return
  }

  if (item.kind === 'link' && getSettings().linkEnrichment) {
    await enrichLink(id, item.content)
    return
  }

  const out = await completeJson(
    'enrichment',
    {
      system: 'You index clipboard snippets for search.',
      prompt:
        `Classify this clipboard snippet. Return JSON: {"title": string (≤80 chars, specific — "PG connection string for staging", not "text snippet"), "tags": string[] (lowercase, ≤6), "content_class": one of ${JSON.stringify(CLASSES)}, "language": string|null (programming language if code)}\n\nSNIPPET:\n${item.content.slice(0, 4000)}`,
      maxTokens: 400
    },
    TextEnrichment
  )
  updateEnrichment(id, {
    autoTitle: out.title,
    tags: out.tags,
    contentClass: out.content_class,
    language: out.language ?? undefined
  })
}

/** Firecrawl scrape when a key is configured — much better on JS-heavy pages. */
async function firecrawlScrape(url: string): Promise<{ text: string; title: string } | null> {
  const key = getSettings().firecrawlApiKey
  if (!key) return null
  try {
    const res = await fetch('https://api.firecrawl.dev/v1/scrape', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ url, formats: ['markdown'], onlyMainContent: true })
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = (await res.json()) as {
      data?: { markdown?: string; metadata?: { title?: string } }
    }
    const text = data.data?.markdown?.slice(0, 8000) ?? ''
    if (!text) return null
    return { text, title: data.data?.metadata?.title ?? '' }
  } catch (err) {
    console.log('[enrich] firecrawl failed, falling back to local fetch:', err)
    return null
  }
}

/** Fetch a copied URL, extract readable text, summarize + tag it into the index. */
async function enrichLink(id: number, url: string): Promise<void> {
  let pageText = ''
  let pageTitle = ''
  const fc = await firecrawlScrape(url.startsWith('http') ? url : `https://${url}`)
  if (fc) {
    pageText = fc.text
    pageTitle = fc.title
  } else try {
    const controller = new AbortController()
    const t = setTimeout(() => controller.abort(), 15_000)
    const res = await fetch(url.startsWith('http') ? url : `https://${url}`, {
      signal: controller.signal,
      headers: { 'user-agent': 'Mozilla/5.0 (clipboard.md link preview)' },
      redirect: 'follow'
    })
    clearTimeout(t)
    const type = res.headers.get('content-type') ?? ''
    if (res.ok && type.includes('html')) {
      const html = (await res.text()).slice(0, 500_000)
      pageTitle = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() ?? ''
      pageText = html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&[a-z#0-9]+;/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 6000)
    }
  } catch (err) {
    console.log(`[enrich] link fetch failed for ${url}:`, err instanceof Error ? err.message : err)
  }

  if (!pageText) {
    updateEnrichment(id, { autoTitle: pageTitle || url.slice(0, 80), contentClass: 'link' })
    return
  }

  const out = await completeJson(
    'enrichment',
    {
      system: 'You index web pages that the user copied links to.',
      prompt: `Summarize this page for clipboard search. Return JSON: {"title": string (≤80 chars, prefer the real title), "tags": string[] (≤6 lowercase), "content_class": "link", "language": null}\n\nURL: ${url}\nPAGE TITLE: ${pageTitle}\nPAGE TEXT:\n${pageText}`,
      maxTokens: 300
    },
    TextEnrichment
  )
  // Page text goes into ocr_text so FTS finds links by what the page said.
  const summary = await complete('enrichment', {
    prompt: `Summarize in 2 sentences what this page is about:\n${pageText.slice(0, 4000)}`,
    maxTokens: 150
  })
  updateEnrichment(id, {
    autoTitle: out.title,
    tags: out.tags,
    contentClass: 'link',
    ocrText: pageText.slice(0, 4000),
    description: summary.trim()
  })
}

/** Assign a session id at capture time: reuse the last session if within the gap. */
export function assignSession(itemId: number, ts: number): void {
  if (!getSettings().sessionsEnabled) return
  const db = getDb()
  const last = db
    .prepare('SELECT id, ended_at FROM sessions ORDER BY ended_at DESC LIMIT 1')
    .get() as { id: number; ended_at: number } | undefined
  let sessionId: number
  if (last && ts - last.ended_at < SESSION_GAP_MS) {
    sessionId = last.id
    db.prepare('UPDATE sessions SET ended_at = ? WHERE id = ?').run(ts, sessionId)
  } else {
    const r = db.prepare('INSERT INTO sessions (started_at, ended_at) VALUES (?, ?)').run(ts, ts)
    sessionId = Number(r.lastInsertRowid)
  }
  db.prepare('UPDATE items SET session_id = ? WHERE id = ?').run(sessionId, itemId)
}

/** Give untitled sessions with enough content an AI title. */
async function titleSessions(): Promise<void> {
  const db = getDb()
  const untitled = db
    .prepare(
      `SELECT s.id FROM sessions s
       WHERE s.title IS NULL
         AND (SELECT COUNT(*) FROM items i WHERE i.session_id = s.id AND i.secret = 0) >= 3
         AND s.ended_at < ?`
    )
    .all(Date.now() - SESSION_GAP_MS) as Array<{ id: number }>
  for (const { id } of untitled.slice(0, 3)) {
    const previews = db
      .prepare(
        `SELECT COALESCE(auto_title, preview) p FROM items
         WHERE session_id = ? AND secret = 0 ORDER BY id LIMIT 12`
      )
      .all(id) as Array<{ p: string }>
    try {
      const title = await complete('enrichment', {
        prompt: `These clipboard items were copied in one work session. Name the session in ≤6 words (what was the user working on?). Output only the name.\n\n${previews.map((r) => '- ' + r.p.slice(0, 120)).join('\n')}`,
        maxTokens: 40
      })
      db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run(title.trim().slice(0, 80), id)
      notify()
    } catch (err) {
      console.error(`[enrich] session ${id} titling failed:`, err)
    }
  }
}
