import { describe, expect, it } from 'vitest'
import { isRepeat } from './dbusService'

describe('hotkey repeat guard', () => {
  it('treats a held key as one press, however long the hold', () => {
    expect(isRepeat('toggle', 1000)).toBe(false)
    // GNOME: first repeat after the ~500 ms delay, then every 30 ms.
    expect(isRepeat('toggle', 1500)).toBe(true)
    for (let t = 1530; t < 4000; t += 30) expect(isRepeat('toggle', t)).toBe(true)
  })

  it('lets a deliberate second press through', () => {
    expect(isRepeat('notes', 10_000)).toBe(false)
    expect(isRepeat('notes', 11_000)).toBe(false)
  })

  it('tracks each action separately', () => {
    expect(isRepeat('rewrite', 20_000)).toBe(false)
    expect(isRepeat('capture', 20_010)).toBe(false)
  })
})
