import { useEffect, useRef } from 'react'
import { EditorState, type Extension } from '@codemirror/state'
import { EditorView, keymap, placeholder as cmPlaceholder, highlightActiveLine } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { syntaxHighlighting, HighlightStyle } from '@codemirror/language'
import { tags } from '@lezer/highlight'

/**
 * Markdown editor built on CodeMirror 6.
 *
 * CodeMirror rather than TipTap/Lexical/BlockNote for one decisive reason: those store
 * a JSON document model, and this app indexes `items.content` as PLAIN TEXT through
 * FTS5 triggers and embeds that same text into items_vec. Storing rich-text JSON in
 * `content` would poison both. Markdown-as-text keeps the entire existing search stack
 * working, and CodeMirror is the editor built for exactly that.
 *
 * It is also the better fit for a keyboard-first app: real keymaps, no floating
 * toolbars, and no block-drag affordances we would then have to design around.
 */

const HIGHLIGHT = HighlightStyle.define([
  { tag: tags.heading1, class: 'cm-h1' },
  { tag: tags.heading2, class: 'cm-h2' },
  { tag: tags.heading3, class: 'cm-h3' },
  { tag: tags.strong, class: 'cm-strong' },
  { tag: tags.emphasis, class: 'cm-em' },
  { tag: tags.strikethrough, class: 'cm-strike' },
  { tag: tags.link, class: 'cm-link' },
  { tag: tags.url, class: 'cm-url' },
  { tag: tags.monospace, class: 'cm-code' },
  { tag: tags.quote, class: 'cm-quote' },
  { tag: tags.list, class: 'cm-list' }
])

/** `[[wikilink]]` isn't markdown, so the grammar won't mark it — decorate it here. */
const WIKILINK_RE = /\[\[([^\]|]+?)(?:\|[^\]]*?)?\]\]/g

const wikilinkTheme = EditorView.baseTheme({
  '.cm-wikilink': { color: 'var(--accent-bright)', cursor: 'pointer', textDecoration: 'underline' }
})

import { Decoration, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { RangeSetBuilder } from '@codemirror/state'

const wikilinkMark = Decoration.mark({ class: 'cm-wikilink' })

function wikilinkPlugin(onOpen: (title: string) => void): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: EditorView) {
        this.decorations = this.build(view)
      }
      update(update: ViewUpdate): void {
        if (update.docChanged || update.viewportChanged) this.decorations = this.build(update.view)
      }
      build(view: EditorView): DecorationSet {
        const builder = new RangeSetBuilder<Decoration>()
        // Only the visible ranges: a long note shouldn't pay to decorate what
        // isn't on screen.
        for (const { from, to } of view.visibleRanges) {
          const text = view.state.doc.sliceString(from, to)
          for (const m of text.matchAll(WIKILINK_RE)) {
            const start = from + (m.index ?? 0)
            builder.add(start, start + m[0].length, wikilinkMark)
          }
        }
        return builder.finish()
      }
    },
    { decorations: (v) => v.decorations }
  )

  // Cmd/Ctrl-click follows the link, matching every other editor's link behaviour.
  const clickHandler = EditorView.domEventHandlers({
    mousedown(event, view) {
      if (!event.metaKey && !event.ctrlKey) return false
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
      if (pos == null) return false
      const line = view.state.doc.lineAt(pos)
      for (const m of line.text.matchAll(WIKILINK_RE)) {
        const start = line.from + (m.index ?? 0)
        if (pos >= start && pos <= start + m[0].length) {
          event.preventDefault()
          onOpen(m[1].trim())
          return true
        }
      }
      return false
    }
  })

  return [plugin, clickHandler, wikilinkTheme]
}

export interface NoteEditorProps {
  /** Body text. Changing `docKey` (not this) is what reloads the document. */
  value: string
  /** Identity of the document being edited — switching notes must reset history. */
  docKey: number | string
  onChange: (value: string) => void
  onOpenLink: (title: string) => void
  placeholder?: string
}

export default function NoteEditor({
  value,
  docKey,
  onChange,
  onOpenLink,
  placeholder = 'Start writing… [[link]] to another note'
}: NoteEditorProps): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  // Kept in a ref so the extension closure never goes stale without rebuilding the
  // editor — recreating CodeMirror on every keystroke would lose the cursor.
  const onChangeRef = useRef(onChange)
  const onOpenRef = useRef(onOpenLink)
  onChangeRef.current = onChange
  onOpenRef.current = onOpenLink

  useEffect(() => {
    if (!host.current) return
    const state = EditorState.create({
      doc: value,
      extensions: [
        history(),
        highlightActiveLine(),
        cmPlaceholder(placeholder),
        // indentWithTab last: Tab is indentation inside the editor, and the default
        // keymap must not claim it first.
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        markdown({ base: markdownLanguage, codeLanguages: languages }),
        syntaxHighlighting(HIGHLIGHT),
        wikilinkPlugin((title) => onOpenRef.current(title)),
        EditorView.lineWrapping,
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChangeRef.current(u.state.doc.toString())
        })
      ]
    })
    const v = new EditorView({ state, parent: host.current })
    view.current = v
    v.focus()
    return () => {
      v.destroy()
      view.current = null
    }
    // Rebuilt only when the document identity changes, so switching notes gets a
    // fresh undo history instead of letting you undo into the previous note.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey])

  // External changes to the same note (e.g. a transcription appended) reconcile
  // without clobbering the cursor when the text already matches.
  useEffect(() => {
    const v = view.current
    if (!v) return
    const current = v.state.doc.toString()
    if (current === value) return
    v.dispatch({ changes: { from: 0, to: current.length, insert: value } })
  }, [value])

  return <div className="note-editor" ref={host} />
}
