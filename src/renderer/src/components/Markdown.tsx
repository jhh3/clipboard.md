import type { ReactNode } from 'react'

/**
 * Tiny markdown renderer for agent replies: fenced code, headings, lists,
 * bold/italic/inline code, links. Builds React elements directly — never HTML —
 * so agent output (which quotes arbitrary clipboard content) has no injection
 * surface. A full parser dependency would buy edge cases chat replies don't hit.
 */

const INLINE = /(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|`[^`]+`|\[[^\]]+\]\((https?:\/\/[^\s)]+)\))/g

function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let i = 0
  for (const m of text.matchAll(INLINE)) {
    const idx = m.index ?? 0
    if (idx > last) out.push(text.slice(last, idx))
    const tok = m[0]
    const key = `${keyBase}-${i++}`
    if (tok.startsWith('**')) out.push(<strong key={key}>{tok.slice(2, -2)}</strong>)
    else if (tok.startsWith('`')) out.push(<code key={key}>{tok.slice(1, -1)}</code>)
    else if (tok.startsWith('[')) {
      const label = tok.slice(1, tok.indexOf(']'))
      out.push(
        <a key={key} href={m[2]} target="_blank" rel="noreferrer">
          {label}
        </a>
      )
    } else out.push(<em key={key}>{tok.slice(1, -1)}</em>)
    last = idx + tok.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

export default function Markdown({ text }: { text: string }): React.JSX.Element {
  const blocks: ReactNode[] = []
  const lines = text.split('\n')
  let i = 0
  let key = 0

  while (i < lines.length) {
    const line = lines[i]

    if (line.trimStart().startsWith('```')) {
      const code: string[] = []
      i++
      while (i < lines.length && !lines[i].trimStart().startsWith('```')) code.push(lines[i++])
      i++ // closing fence
      blocks.push(
        <pre key={key++} className="md-code">
          {code.join('\n')}
        </pre>
      )
      continue
    }

    const h = /^(#{1,4})\s+(.*)$/.exec(line)
    if (h) {
      blocks.push(
        <div key={key++} className={`md-h md-h${h[1].length}`}>
          {inline(h[2], `h${key}`)}
        </div>
      )
      i++
      continue
    }

    const isItem = (l: string): boolean => /^\s*([-*+]|\d+[.)])\s+/.test(l)
    if (isItem(line)) {
      const items: string[] = []
      while (i < lines.length && isItem(lines[i])) {
        items.push(lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, ''))
        i++
      }
      blocks.push(
        <ul key={key++} className="md-list">
          {items.map((it, j) => (
            <li key={j}>{inline(it, `li${key}-${j}`)}</li>
          ))}
        </ul>
      )
      continue
    }

    if (line.trim() === '') {
      i++
      continue
    }

    // Paragraph: consume until a blank line or a structural line.
    const para: string[] = []
    while (i < lines.length && lines[i].trim() !== '' && !isItem(lines[i]) && !/^#{1,4}\s/.test(lines[i]) && !lines[i].trimStart().startsWith('```')) {
      para.push(lines[i])
      i++
    }
    blocks.push(
      <p key={key++} className="md-p">
        {inline(para.join('\n'), `p${key}`)}
      </p>
    )
  }

  return <div className="md">{blocks}</div>
}
