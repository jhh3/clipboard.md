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

/** Circuit breaker: consecutive failures pause the queue instead of hammering. */
let consecutiveFailures = 0
let pausedUntil = 0
const MAX_PER_DRAIN = 20

export async function drain(): Promise<void> {
  if (running) return
  const settings = getSettings()
  if (!settings.enrichment.enabled) return
  if (Date.now() < pausedUntil) return
  running = true
  try {
    // Bounded per drain: an outage previously meant every queued item burned
    // 4 providers x 3 attempts x a 90s timeout, back to back, forever.
    let handled = 0
    while (handled < MAX_PER_DRAIN) {
      const batch = nextEnrichQueueBatch(2)
      if (batch.length === 0) break
      for (const item of batch) {
        handled++
        try {
          await enrichOne(item.id)
          dequeueEnrichment(item.id)
          consecutiveFailures = 0
          processed++
          notify()
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          lastError = msg
          console.error(`[enrich] item ${item.id} failed:`, msg)
          dequeueEnrichment(item.id, msg)
          consecutiveFailures++
          if (consecutiveFailures >= 5) {
            // Exponential, capped: 1m, 2m, 4m … 30m.
            const backoff = Math.min(60_000 * 2 ** (consecutiveFailures - 5), 30 * 60_000)
            pausedUntil = Date.now() + backoff
            console.error(
              `[enrich] ${consecutiveFailures} consecutive failures; pausing ${Math.round(backoff / 1000)}s`
            )
            return
          }
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

/**
 * Copying a URL is not consent to visit it. Refuse anything that would turn the
 * clipboard into an SSRF gadget (loopback, LAN, link-local, non-http schemes) or
 * that would leak a credentialed link to a third party.
 */
function isFetchableUrl(raw: string): URL | null {
  let url: URL
  try {
    url = new URL(raw.startsWith('http') ? raw : `https://${raw}`)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.username || url.password) return null

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host === '::1' ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^169\.254\./.test(host) || // link-local, incl. cloud metadata
    /^f[cd][0-9a-f]{2}:/i.test(host) || // unique-local IPv6
    /^fe80:/i.test(host) // link-local IPv6
  ) {
    return null
  }
  // Signed/pre-authenticated links: fetching them is an action, and shipping them
  // to a scraper leaks the credential.
  if (/(^|[?&])(token|access_token|api_key|apikey|signature|sig|x-amz-signature|password)=/i.test(url.search)) {
    return null
  }
  return url
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
      data?: { markdown?: string; metadata?: { title?: string; statusCode?: number } }
    }
    // Firecrawl happily renders the TARGET's error page and returns it as a
    // successful scrape — a private GitHub repo came back as a fully-enriched
    // "Page not found · GitHub" clip. The page's own status is in metadata.
    const status = data.data?.metadata?.statusCode
    if (status != null && status >= 400) return null
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
  const safe = isFetchableUrl(url)
  if (!safe) {
    updateEnrichment(id, { autoTitle: url.slice(0, 80), contentClass: 'link' })
    return
  }
  const fc = await firecrawlScrape(safe.toString())
  if (fc) {
    pageText = fc.text
    pageTitle = fc.title
  } else try {
    const controller = new AbortController()
    const t = setTimeout(() => controller.abort(), 15_000)
    let res: Response
    try {
      res = await fetch(safe.toString(), {
        signal: controller.signal,
        headers: { 'user-agent': 'Mozilla/5.0 (clipboard.md link preview)' },
        // 'manual' so a public URL can't redirect us onto a private address.
        redirect: 'manual'
      })
      if (res.status >= 300 && res.status < 400) {
        const next = res.headers.get('location')
        const safeNext = next ? isFetchableUrl(new URL(next, safe).toString()) : null
        if (!safeNext) throw new Error(`refusing redirect to ${next ?? 'unknown'}`)
        res = await fetch(safeNext.toString(), {
          signal: controller.signal,
          headers: { 'user-agent': 'Mozilla/5.0 (clipboard.md link preview)' },
          redirect: 'manual'
        })
      }
    } finally {
      clearTimeout(t) // was leaked whenever fetch threw
    }
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

  // Auth walls and error pages that come back with HTTP 200: what we fetched is
  // the SITE's furniture, not the user's page — indexing it produces clips titled
  // "Page not found" or "Sign in" for perfectly good private links. Heuristic on
  // purpose; a false positive just leaves the URL as the title, which is honest.
  const AUTH_WALL_RE =
    /^(sign in|log ?in|page not found|not found|404|403|access denied|authentication required|unauthori[sz]ed|verify your)/i
  if (
    AUTH_WALL_RE.test(pageTitle.trim()) ||
    /\b(sign|log) in to (continue|access|view)\b/i.test(pageText.slice(0, 500))
  ) {
    console.log(`[enrich] ${url} looks auth-walled ("${pageTitle.slice(0, 40)}"); keeping the bare link`)
    updateEnrichment(id, { autoTitle: url.slice(0, 80), contentClass: 'link' })
    return
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
