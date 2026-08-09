import { useEffect, useState } from 'react'
import type { ClipItem } from '@shared/types'
import { invoke } from '../lib/ipc'
import { fullDate } from '../lib/time'
import { KindIcon, SparkIcon } from './icons'

/** Full-resolution image data URLs, cached per item id (thumbs are capped at 320px). */
const imageCache = new Map<number, string>()
const IMAGE_CACHE_MAX = 24

/**
 * Search results carry only previews — full text is fetched for the selected item
 * alone, so a 400-row result doesn't ship every clip's body across IPC. Returns the
 * item unchanged once hydrated (or immediately if it already has content).
 */
function useHydratedItem(item: ClipItem | null): ClipItem | null {
  const [full, setFull] = useState<ClipItem | null>(item)

  useEffect(() => {
    if (!item) {
      setFull(null)
      return
    }
    // Images keep their file path in `content`; only text-ish kinds are stripped.
    if (item.kind === 'image' || item.content || item.secret) {
      setFull(item)
      return
    }
    setFull(item) // show preview text immediately, upgrade when the body arrives
    let live = true
    invoke('item:get', item.id)
      .then((res) => {
        if (live && res) setFull(res)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [item])

  return full
}

/** Debounced fetch of the full-res image for `id`; null while loading / unavailable. */
function useFullImage(id: number | null): string | null {
  const [src, setSrc] = useState<string | null>(() =>
    id != null ? (imageCache.get(id) ?? null) : null
  )

  useEffect(() => {
    if (id == null) {
      setSrc(null)
      return
    }
    const cached = imageCache.get(id)
    if (cached) {
      setSrc(cached)
      return
    }
    setSrc(null)
    let live = true
    // Debounce: skip fetching while the user is arrowing through the list.
    const t = window.setTimeout(() => {
      invoke('item:image-data', id)
        .then((data) => {
          if (data) {
            if (imageCache.size >= IMAGE_CACHE_MAX) {
              const oldest = imageCache.keys().next().value
              if (oldest != null) imageCache.delete(oldest)
            }
            imageCache.set(id, data)
          }
          if (live) setSrc(data)
        })
        .catch(() => {})
    }, 160)
    return () => {
      live = false
      window.clearTimeout(t)
    }
  }, [id])

  return src
}

function ImageContent({ item, dimmed }: { item: ClipItem; dimmed?: boolean }) {
  const full = useFullImage(item.id)
  const src = full ?? item.thumb
  return (
    <figure className={'preview-image' + (dimmed ? ' dimmed' : '')}>
      {src ? (
        <img src={src} alt={item.autoTitle ?? 'Clipboard image'} draggable={false} />
      ) : (
        <div className="image-missing">No preview available</div>
      )}
      {item.width != null && item.height != null && (
        <figcaption>
          {item.width} × {item.height} px{full == null && src != null ? ' · loading full…' : ''}
        </figcaption>
      )}
    </figure>
  )
}

export interface TransformView {
  output: string
  outputKind: 'text' | 'image'
  /** Human label of what produced this: action title or the free prompt. */
  label: string
}

interface Props {
  item: ClipItem | null
  /** When set, the pane shows the before/after transform view. */
  result: TransformView | null
}

function ContentBlock({ item, dimmed }: { item: ClipItem; dimmed?: boolean }) {
  if (item.secret) {
    return (
      <div className={'preview-secret' + (dimmed ? ' dimmed' : '')}>
        <KindIcon kind={item.kind} secret size={18} />
        <div>
          <div className="secret-title">Concealed content</div>
          <div className="secret-sub">Flagged as a secret — masked and never sent to AI.</div>
        </div>
      </div>
    )
  }
  if (item.kind === 'image') {
    return <ImageContent item={item} dimmed={dimmed} />
  }
  if (item.kind === 'code') {
    return (
      <div className={'preview-code' + (dimmed ? ' dimmed' : '')}>
        <span className="code-lang">{item.language ?? 'code'}</span>
        <pre className="mono">{item.content}</pre>
      </div>
    )
  }
  if (item.kind === 'color') {
    return (
      <div className={'preview-color' + (dimmed ? ' dimmed' : '')}>
        <span className="color-swatch" style={{ background: item.content }} />
        <code className="mono">{item.content}</code>
      </div>
    )
  }
  // Falls back to the preview while the full body is in flight.
  return (
    <pre className={'preview-text' + (dimmed ? ' dimmed' : '')}>{item.content || item.preview}</pre>
  )
}

function MetaFooter({ item }: { item: ClipItem }) {
  return (
    <div className="meta-footer">
      {item.derivedFrom != null && (
        <div className="lineage">
          <SparkIcon size={11} />
          derived via <em>{item.derivedVia ?? 'transform'}</em> from #{item.derivedFrom}
        </div>
      )}
      {/* The AI summary — computed for links and images since day one, shown
          nowhere until John asked where all this information actually was. */}
      {!item.secret && item.description && (
        <div className="meta-description">
          <SparkIcon size={11} />
          <span>{item.description}</span>
        </div>
      )}
      {!item.secret && item.ocrText && (
        <div className="ocr-block">
          {/* For links this field holds fetched page text, not OCR. */}
          <span className="ocr-badge">{item.kind === 'image' ? 'text in image' : 'page text'}</span>
          <span className="ocr-snippet">{item.ocrText.slice(0, 220)}</span>
        </div>
      )}
      {item.tags.length > 0 && (
        <div className="meta-tags">
          {item.tags.map((t) => (
            <span key={t} className="tag-chip">
              {t}
            </span>
          ))}
        </div>
      )}
      <div className="meta-line">
        {item.sourceApp && <span>{item.sourceApp}</span>}
        <span>copied {item.copyCount}×</span>
        <span>{fullDate(item.createdAt)}</span>
        {item.contentClass && <span className="class-badge">{item.contentClass}</span>}
        {!item.secret && item.charCount > 0 && item.kind !== 'image' && (
          <span>{item.charCount.toLocaleString()} chars</span>
        )}
      </div>
    </div>
  )
}

export default function PreviewPane({ item: listItem, result }: Props) {
  const item = useHydratedItem(listItem)
  if (!item) {
    return (
      <div className="preview-pane preview-empty">
        <span>Select an item to preview</span>
      </div>
    )
  }

  if (result) {
    return (
      <div className="preview-pane">
        <div className="preview-scroll">
          <div className="result-header">
            <SparkIcon className="result-spark" size={13} />
            <span className="result-label" title={result.label}>
              {result.label}
            </span>
            <span className="result-badge">transformed</span>
          </div>
          {result.outputKind === 'image' ? (
            <figure className="preview-image result-output">
              <img src={result.output} alt="Transformed output" draggable={false} />
            </figure>
          ) : (
            <pre className="preview-text result-output">{result.output}</pre>
          )}
          <div className="result-divider">original</div>
          <ContentBlock item={item} dimmed />
        </div>
      </div>
    )
  }

  return (
    <div className="preview-pane">
      <div className="preview-scroll">
        <ContentBlock item={item} />
      </div>
      <MetaFooter item={item} />
    </div>
  )
}
