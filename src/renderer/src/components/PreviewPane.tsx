import type { ClipItem } from '@shared/types'
import { fullDate } from '../lib/time'
import { KindIcon, SparkIcon } from './icons'

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
    return (
      <figure className={'preview-image' + (dimmed ? ' dimmed' : '')}>
        {item.thumb ? (
          <img src={item.thumb} alt={item.autoTitle ?? 'Clipboard image'} draggable={false} />
        ) : (
          <div className="image-missing">No preview available</div>
        )}
        {item.width != null && item.height != null && (
          <figcaption>
            {item.width} × {item.height} px
          </figcaption>
        )}
      </figure>
    )
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
  return <pre className={'preview-text' + (dimmed ? ' dimmed' : '')}>{item.content}</pre>
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
      {!item.secret && item.ocrText && (
        <div className="ocr-block">
          <span className="ocr-badge">matched via OCR</span>
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

export default function PreviewPane({ item, result }: Props) {
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
