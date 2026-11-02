import { describe, it, expect } from 'vitest'
import { gnomeBindingFor, portalDictationShortcuts, setDictationHandledElsewhere } from './hotkeys'

/**
 * A held GNOME custom keybinding runs its command on every key repeat, and each run
 * left a dead systemd scope behind — ~18,000 of them, systemd --user at ~100% CPU.
 * The dictation bindings must go empty once something else delivers those keys.
 */
describe('dictation keys handled elsewhere', () => {
  it('empties only the GNOME bindings that are handled elsewhere', () => {
    setDictationHandledElsewhere(['--dictate'])
    expect(gnomeBindingFor('--dictate', '<Control><Alt><Shift>d')).toBe('')
    expect(gnomeBindingFor('--dictate-enhance', '<Control><Alt><Shift>v')).toBe('<Control><Alt><Shift>v')
    // Never the non-dictation keys: they are taps, and GNOME is their only trigger.
    expect(gnomeBindingFor('--toggle', '<Control><Alt>v')).toBe('<Control><Alt>v')
  })

  it('restores the binding when the other source goes away', () => {
    setDictationHandledElsewhere(['--dictate'])
    expect(setDictationHandledElsewhere([])).toBe(true)
    expect(gnomeBindingFor('--dictate', '<Control><Alt>space')).toBe('<Control><Alt>space')
  })

  it('reports no change for the same set, so gsettings is not rewritten', () => {
    setDictationHandledElsewhere(['--dictate'])
    expect(setDictationHandledElsewhere(['--dictate'])).toBe(false)
    setDictationHandledElsewhere([])
  })
})

describe('portalDictationShortcuts', () => {
  it('requests every configured dictation chord in the portal trigger form', () => {
    expect(
      portalDictationShortcuts({
        dictateChord: 'Ctrl+Alt+Shift+D',
        dictateEnhanceChord: 'Ctrl+Alt+Shift+V'
      }).map((s) => [s.id, s.trigger])
    ).toEqual([
      ['paste', 'CTRL+ALT+SHIFT+d'],
      ['enhance', 'CTRL+ALT+SHIFT+v']
    ])
  })

  it('uses the default for the main key and skips unbound ones', () => {
    expect(portalDictationShortcuts({}).map((s) => [s.id, s.trigger])).toEqual([
      ['paste', 'CTRL+ALT+space']
    ])
  })
})
