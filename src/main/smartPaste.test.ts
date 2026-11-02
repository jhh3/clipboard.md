import { describe, it, expect } from 'vitest'
import { destinationRole, shapeForDestination } from './paste'
import type { ClipItem } from '@shared/types'

/**
 * The smart-paste decision table.
 *
 * Destination detection is macOS-only (the helper reports the frontmost bundle id).
 */
const clip = (over: Partial<ClipItem> = {}): ClipItem =>
  ({ id: 1, kind: 'text', content: 'hello', preview: 'hello', ...over }) as ClipItem

describe('destinationRole (darwin)', () => {
  it('classifies the shipped bundle identifiers exactly as before', () => {
    for (const id of [
      'com.apple.Terminal',
      'com.googlecode.iterm2',
      'dev.warp.Warp-Stable',
      'net.kovidgoyal.kitty',
      'org.alacritty',
      'com.github.wez.wezterm',
      'com.mitchellh.ghostty'
    ]) {
      expect(destinationRole(id, 'darwin'), id).toBe('terminal')
    }
    expect(destinationRole('com.tinyspeck.slackmacgap', 'darwin')).toBe('chat')
    expect(destinationRole('com.hnc.Discord', 'darwin')).toBe('chat')
    expect(destinationRole('com.microsoft.VSCode', 'darwin')).toBeNull()
    expect(destinationRole(null, 'darwin')).toBeNull()
  })

  it('is case-sensitive on darwin, where bundle ids are', () => {
    // Bundle ids are case-sensitive, or a user-supplied id would match something
    // it does not name.
    expect(destinationRole('com.apple.terminal', 'darwin')).toBeNull()
  })
})

describe('shapeForDestination', () => {
  it('does nothing when smart paste is off', () => {
    expect(shapeForDestination(clip(), false, 'terminal', false)).toEqual({ plain: false })
  })

  it('does nothing for an unknown destination', () => {
    expect(shapeForDestination(clip(), false, null, true)).toEqual({ plain: false })
  })

  it('forces plain text into a terminal', () => {
    expect(shapeForDestination(clip({ html: '<b>x</b>' }), false, 'terminal', true)).toEqual({ plain: true })
  })

  it('fences a code clip into chat', () => {
    const out = shapeForDestination(clip({ kind: 'code', content: 'x = 1', language: 'py' }), false, 'chat', true)
    expect(out).toEqual({ plain: true, text: '```py\nx = 1\n```' })
  })

  it('leaves an already-fenced clip alone', () => {
    const content = '```\nx = 1\n```'
    expect(shapeForDestination(clip({ kind: 'code', content }), false, 'chat', true)).toEqual({ plain: false })
  })

  it('never fences when the user asked for a plain paste', () => {
    expect(shapeForDestination(clip({ kind: 'code', content: 'x' }), true, 'chat', true)).toEqual({ plain: true })
  })
})
