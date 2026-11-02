import { z } from 'zod'
import type { ClipItem } from '@shared/types'
import { completeJson, ProviderError, describeProviderError } from './modelport'
import {
  nextEnrichQueueBatch,
  dequeueEnrichment,
  updateEnrichment,
  reviveEnrichmentQueue
} from './store/items'
import { getSettings, onSettingsChanged } from './settings'
import { ocrImage } from './ocr'

/**
 * Background AI tagging: a direct API call per batch of clips (title, tags, class).
 * Screenshots are read locally (ocr/) and only the extracted text is sent for tags.
 *
 * Provider outages (no key, bad key, quota, network) never count against an item:
 * they trip a breaker that pauses the queue and shows why in the tray. Only an item
 * the model cannot handle (bad JSON twice) uses up one of its three attempts.
 */

const CLASSES = [
  'code', 'link', 'error', 'address', 'contact', 'meeting',
  'prose', 'command', 'data', 'screenshot', 'photo', 'other'
] as const

const Tagging = z.object({
  title: z.string().max(120),
  tags: z.array(z.string().max(32)).max(6),
  content_class: z.enum(CLASSES),
  language: z.string().max(24).nullish()
})

const TextBatch = z.object({
  items: z.array(Tagging.extend({ id: z.number() }))
})

const LinkTagging = z.object({
  title: z.string().max(120),
  tags: z.array(z.string().max(32)).max(6),
  summary: z.string().max(600)
})

const TEXT_BATCH = 8
const MAX_PER_DRAIN = 48
const CONCURRENCY = 4

let running = false
let processed = 0
let lastError: string | undefined
let timer: ReturnType<typeof setInterval> | null = null
let notify: () => void = () => {}

/** Breaker: an outage pauses the queue with exponential backoff (1m … 30m). */
let outage: string | undefined
let outageCount = 0
let pausedUntil = 0
const statusListeners = new Set<() => void>()

export function startEnrichment(onChanged: () => void): void {
  notify = onChanged
  // Rows that died to the expired-login era (or any outage) get one more chance.
  const revived = reviveEnrichmentQueue()
  if (revived > 0) console.log(`[enrich] re-queued ${revived} items that had given up`)
  // A key typed into Settings should resume tagging now, not after the backoff.
  let lastKeys = JSON.stringify(getSettings().apiKeys ?? {})
  onSettingsChanged((s) => {
    const keys = JSON.stringify(s.apiKeys ?? {})
    if (keys === lastKeys) return
    lastKeys = keys
    void resumeEnrichment()
  })
  if (!timer) timer = setInterval(() => void drain(), 15_000)
  void drain()
}

/** Lift a breaker pause and drain now (a new key was entered). */
export function resumeEnrichment(): Promise<void> {
  pausedUntil = 0
  outageCount = 0
  return drain()
}

export function stopEnrichment(): void {
  if (timer) clearInterval(timer)
  timer = null
}

export function enrichmentRunStats(): { processed: number; lastError?: string; outage?: string } {
  return { processed, lastError: outage ?? lastError, outage }
}

/** Why AI tagging is paused, for the tray; undefined when it is working. */
export function enrichmentOutage(): string | undefined {
  return outage
}

export function onEnrichmentStatus(fn: () => void): () => void {
  statusListeners.add(fn)
  return () => statusListeners.delete(fn)
}

function setOutage(next: string | undefined): void {
  if (next === outage) return
  outage = next
  for (const fn of statusListeners) fn()
}

function tripBreaker(err: ProviderError): void {
  setOutage(describeProviderError(err))
  // Parallel units hitting the same outage count once.
  if (Date.now() < pausedUntil) return
  outageCount++
  const backoff = Math.min(60_000 * 2 ** (outageCount - 1), 30 * 60_000)
  pausedUntil = Date.now() + backoff
  console.error(`[enrich] provider outage (${err.kind}); pausing ${Math.round(backoff / 1000)}s`)
}

function isOutage(err: unknown): err is ProviderError {
  return err instanceof ProviderError && err.isOutage
}

export async function drain(): Promise<void> {
  if (running) return
  if (!getSettings().enrichment.enabled) return
  if (Date.now() < pausedUntil) return
  running = true
  const started = Date.now()
  let handled = 0
  try {
    while (handled < MAX_PER_DRAIN && Date.now() >= pausedUntil) {
      const items = nextEnrichQueueBatch(TEXT_BATCH * CONCURRENCY)
      if (items.length === 0) break
      handled += items.length
      const units = planUnits(items)
      // A small pool: a backlog drains in parallel, and one outage stops the rest.
      let next = 0
      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, units.length) }, async () => {
          while (next < units.length && Date.now() >= pausedUntil) await runUnit(units[next++])
        })
      )
    }
  } finally {
    running = false
    if (handled > 0) console.log(`[enrich] drained ${handled} items in ${Date.now() - started}ms`)
  }
}

type Unit = { kind: 'text'; items: ClipItem[] } | { kind: 'link' | 'image' | 'skip'; items: [ClipItem] }

function planUnits(items: ClipItem[]): Unit[] {
  const units: Unit[] = []
  const text: ClipItem[] = []
  const linkEnrichment = getSettings().linkEnrichment
  for (const item of items) {
    if (item.secret) units.push({ kind: 'skip', items: [item] })
    else if (item.kind === 'image') units.push({ kind: 'image', items: [item] })
    else if (item.kind === 'link' && linkEnrichment) units.push({ kind: 'link', items: [item] })
    else text.push(item)
  }
  for (let i = 0; i < text.length; i += TEXT_BATCH) units.push({ kind: 'text', items: text.slice(i, i + TEXT_BATCH) })
  return units
}

async function runUnit(unit: Unit): Promise<void> {
  try {
    if (unit.kind === 'skip') dequeueEnrichment(unit.items[0].id)
    else if (unit.kind === 'image') await enrichImage(unit.items[0])
    else if (unit.kind === 'link') await enrichLink(unit.items[0])
    else await enrichTextBatch(unit.items)
    succeeded(unit.items.length)
  } catch (err) {
    if (isOutage(err)) return tripBreaker(err)
    // A batch the model fumbled: retry its clips one at a time before charging them.
    if (unit.kind === 'text' && unit.items.length > 1) {
      for (const item of unit.items) await runUnit({ kind: 'text', items: [item] })
      return
    }
    const msg = err instanceof Error ? err.message : String(err)
    lastError = msg
    console.error(`[enrich] item ${unit.items[0].id} (${unit.kind}) failed: ${msg.slice(0, 200)}`)
    dequeueEnrichment(unit.items[0].id, msg)
  }
}

function succeeded(n: number): void {
  processed += n
  outageCount = 0
  setOutage(undefined)
  notify()
}

async function enrichTextBatch(items: ClipItem[]): Promise<void> {
  const snippets = items
    .map((i) => `<snippet id="${i.id}">\n${i.content.slice(0, 2000)}\n</snippet>`)
    .join('\n')
  const out = await completeJson(
    'enrichment',
    {
      system: 'You index clipboard snippets for search.',
      prompt:
        `Classify each clipboard snippet below. Return JSON: {"items": [{"id": number (the snippet id), "title": string (≤80 chars, specific — "PG connection string for staging", not "text snippet"), "tags": string[] (lowercase, ≤6), "content_class": one of ${JSON.stringify(CLASSES)}, "language": string|null (programming language if code)}]}, one entry per snippet.\n\n${snippets}`,
      maxTokens: 120 * items.length + 100,
      timeoutMs: 8_000 + 2_000 * items.length
    },
    TextBatch
  )
  const byId = new Map(out.items.map((r) => [r.id, r]))
  for (const item of items) {
    const r = byId.get(item.id)
    if (!r) {
      // Counted: the model answered but skipped it. Three of these and it is dropped.
      dequeueEnrichment(item.id, 'missing from batch result')
      continue
    }
    updateEnrichment(item.id, {
      autoTitle: r.title,
      tags: r.tags,
      contentClass: r.content_class,
      language: r.language ?? undefined
    })
    dequeueEnrichment(item.id)
  }
}

/**
 * Screenshots: read the text locally, store it (so it is searchable even if tagging
 * fails), then tag from that text alone. Image bytes never leave the machine, and an
 * image with no text gets no tags.
 */
async function enrichImage(item: ClipItem): Promise<void> {
  const text = item.ocrText ?? (await ocrImage(item.content)).trim()
  if (item.ocrText === undefined) updateEnrichment(item.id, { ocrText: text })
  if (text) {
    const out = await completeJson(
      'enrichment',
      {
        system: 'You index clipboard screenshots for search, from the text read out of them.',
        prompt: `This text was read from a screenshot. Return JSON: {"title": string (≤80 chars: what the screenshot shows, e.g. "GitHub Actions deploy failure"), "tags": string[] (lowercase, ≤6), "content_class": one of ${JSON.stringify(CLASSES)}, "language": null}\n\nTEXT:\n${text.slice(0, 4000)}`,
        maxTokens: 200
      },
      Tagging
    )
    updateEnrichment(item.id, {
      autoTitle: out.title,
      tags: out.tags,
      contentClass: out.content_class === 'screenshot' || out.content_class === 'photo' ? out.content_class : 'screenshot'
    })
  }
  dequeueEnrichment(item.id)
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
      body: JSON.stringify({ url, formats: ['markdown'], onlyMainContent: true }),
      signal: AbortSignal.timeout(20_000)
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
    console.log('[enrich] firecrawl failed, falling back to local fetch:', err instanceof Error ? err.message : err)
    return null
  }
}

/** Fetch a copied URL, extract readable text, summarize + tag it into the index. */
async function enrichLink(item: ClipItem): Promise<void> {
  const { id, content: url } = item
  const finish = (patch: Parameters<typeof updateEnrichment>[1]): void => {
    updateEnrichment(id, patch)
    dequeueEnrichment(id)
  }
  let pageText = ''
  let pageTitle = ''
  const safe = isFetchableUrl(url)
  if (!safe) return finish({ autoTitle: url.slice(0, 80), contentClass: 'link' })
  const fc = await firecrawlScrape(safe.toString())
  if (fc) {
    pageText = fc.text
    pageTitle = fc.title
  } else try {
    const signal = AbortSignal.timeout(15_000)
    const headers = { 'user-agent': 'Mozilla/5.0 (clipboard.md link preview)' }
    // 'manual' so a public URL can't redirect us onto a private address.
    let res = await fetch(safe.toString(), { signal, headers, redirect: 'manual' })
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get('location')
      const safeNext = next ? isFetchableUrl(new URL(next, safe).toString()) : null
      if (!safeNext) throw new Error('refusing redirect to a private or unparseable address')
      res = await fetch(safeNext.toString(), { signal, headers, redirect: 'manual' })
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
    // No URL here: the log is metadata only.
    console.log(`[enrich] link fetch failed for item ${id}:`, err instanceof Error ? err.message : err)
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
    return finish({ autoTitle: url.slice(0, 80), contentClass: 'link' })
  }

  if (!pageText) return finish({ autoTitle: pageTitle || url.slice(0, 80), contentClass: 'link' })

  const out = await completeJson(
    'enrichment',
    {
      system: 'You index web pages that the user copied links to.',
      prompt: `Summarize this page for clipboard search. Return JSON: {"title": string (≤80 chars, prefer the real title), "tags": string[] (≤6 lowercase), "summary": string (2 sentences: what the page is about)}\n\nURL: ${url}\nPAGE TITLE: ${pageTitle}\nPAGE TEXT:\n${pageText.slice(0, 5000)}`,
      maxTokens: 300,
      timeoutMs: 15_000
    },
    LinkTagging
  )
  // Page text goes into ocr_text so FTS finds links by what the page said.
  finish({
    autoTitle: out.title,
    tags: out.tags,
    contentClass: 'link',
    ocrText: pageText.slice(0, 4000),
    description: out.summary.trim()
  })
}
