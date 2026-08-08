import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { openDb, closeDb } from './db'
import { searchKeyword, upsertClip } from './items'
import {
  parseWikilinks,
  deriveTitle,
  createNote,
  updateNote,
  getNote,
  listNotes,
  backlinks,
  outgoingLinks,
  findNoteByTitle,
  resolveLinksTo,
  dailyNote
} from './notes'

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'clipmd-notes-test-'))
  openDb(dir)
})

afterAll(() => {
  closeDb()
  rmSync(dir, { recursive: true, force: true })
})

describe('parseWikilinks', () => {
  it('extracts targets', () => {
    expect(parseWikilinks('see [[Reading list]] and [[Todo]]')).toEqual(['Reading list', 'Todo'])
  })

  it('supports the [[target|alias]] form, keying on the target', () => {
    expect(parseWikilinks('[[Reading list|my books]]')).toEqual(['Reading list'])
  })

  it('de-duplicates case-insensitively — [[Todo]] and [[todo]] are one note', () => {
    expect(parseWikilinks('[[Todo]] then [[todo]] then [[TODO]]')).toEqual(['Todo'])
  })

  it('ignores empty and unclosed links', () => {
    expect(parseWikilinks('[[]] and [[ ]] and [[unclosed')).toEqual([])
  })
})

describe('deriveTitle', () => {
  it('uses the first non-empty line and strips heading marks', () => {
    expect(deriveTitle('## Groceries\n\nmilk')).toBe('Groceries')
    expect(deriveTitle('\n\n  first real line\nsecond')).toBe('first real line')
  })

  it('falls back for an empty body', () => {
    expect(deriveTitle('   \n\n')).toBe('Untitled note')
  })
})

describe('notes', () => {
  it('creates blank notes without colliding', () => {
    // Clips dedupe by content hash; two empty notes must NOT become one note.
    const a = createNote()
    const b = createNote()
    expect(a).not.toBe(b)
    expect(getNote(a)).not.toBeNull()
    expect(getNote(b)).not.toBeNull()
  })

  it('derives a title when none is given, and keeps an explicit one', () => {
    const derived = createNote({ content: '# Shopping\n\neggs' })
    expect(getNote(derived)?.title).toBe('Shopping')
    const explicit = createNote({ title: 'Kept', content: '# Ignored heading' })
    expect(getNote(explicit)?.title).toBe('Kept')
  })

  it('edits in place rather than creating a new row', () => {
    const id = createNote({ title: 'Draft', content: 'one' })
    updateNote(id, { content: 'two' })
    const note = getNote(id)
    expect(note?.id).toBe(id)
    expect(note?.content).toBe('two')
    expect(note?.updatedAt).toBeGreaterThanOrEqual(note!.createdAt)
  })

  it('is findable by title, case-insensitively', () => {
    createNote({ title: 'Reading List', content: 'x' })
    expect(findNoteByTitle('reading list')).not.toBeNull()
  })

  it('filters the list by substring over title and body', () => {
    createNote({ title: 'Zebra facts', content: 'stripes' })
    expect(listNotes({ q: 'zebra' }).some((n) => n.title === 'Zebra facts')).toBe(true)
    expect(listNotes({ q: 'stripes' }).some((n) => n.title === 'Zebra facts')).toBe(true)
    expect(listNotes({ q: 'nothingmatchesthis' })).toHaveLength(0)
  })
})

describe('links and backlinks', () => {
  it('records a backlink once both notes exist', () => {
    const target = createNote({ title: 'Target note', content: 'hi' })
    const source = createNote({ title: 'Source note', content: 'see [[Target note]]' })
    expect(backlinks(target).map((n) => n.id)).toContain(source)
    expect(outgoingLinks(source)).toEqual([{ title: 'Target note', toId: target }])
  })

  it('stores an unresolved link, then adopts it when the note is created', () => {
    // Writing [[Later]] before that note exists must not lose the edge — otherwise
    // creating it afterwards would never show the backlink.
    const source = createNote({ title: 'Early', content: 'points at [[Later note]]' })
    expect(outgoingLinks(source)).toEqual([{ title: 'Later note', toId: null }])

    const later = createNote({ title: 'Later note', content: 'here' })
    resolveLinksTo(later, 'Later note')
    expect(outgoingLinks(source)).toEqual([{ title: 'Later note', toId: later }])
    expect(backlinks(later).map((n) => n.id)).toContain(source)
  })

  it('drops an edge when the link is removed from the body', () => {
    const target = createNote({ title: 'Droppable', content: 'x' })
    const source = createNote({ title: 'Dropper', content: 'ref [[Droppable]]' })
    expect(backlinks(target).map((n) => n.id)).toContain(source)

    updateNote(source, { content: 'no more references' })
    expect(backlinks(target).map((n) => n.id)).not.toContain(source)
  })

  it('creates the daily note once and reuses it', () => {
    const first = dailyNote(new Date(2026, 0, 15))
    const second = dailyNote(new Date(2026, 0, 15))
    expect(second).toBe(first)
    expect(getNote(first)?.title).toBe('2026-01-15')
  })
})

describe('integration with the existing item index', () => {
  it('makes notes findable through the normal search index', () => {
    // The whole reason notes are items: FTS5 and embeddings come for free.
    createNote({ title: 'Kubernetes runbook', content: 'restart the ingress controller' })
    const hits = searchKeyword({ q: 'ingress', mode: 'keyword' })
    expect(hits.items.some((i) => i.kind === 'note')).toBe(true)
  })

  it('finds a note by its title, which clips do not have', () => {
    createNote({ title: 'Distinctivetitleword', content: 'body text' })
    const hits = searchKeyword({ q: 'Distinctivetitleword', mode: 'keyword' })
    expect(hits.items.some((i) => i.kind === 'note')).toBe(true)
  })

  it('keeps notes out of a clip-kind filter', () => {
    upsertClip({ kind: 'text', content: 'an ordinary clip', preview: 'an ordinary clip', secret: false })
    const textOnly = searchKeyword({ q: '', mode: 'keyword', kind: 'text' })
    expect(textOnly.items.every((i) => i.kind !== 'note')).toBe(true)
  })
})
