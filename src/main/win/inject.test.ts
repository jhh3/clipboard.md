import { describe, it, expect } from 'vitest'
import { inputSize, keyInputs, pasteStrokes, strayModifierReleases, VK } from './inject'

/**
 * The struct layout, asserted byte by byte.
 *
 * This is the one part of the port where being wrong produces no error at all.
 * SendInput reads `cbSize` bytes per entry and returns how many it "sent" — a struct
 * that is the wrong size sends garbage virtual-key codes into the user's focused
 * window and reports complete success. There is no exception to catch and no log
 * line to read; you find out because something typed itself.
 */
describe('INPUT layout', () => {
  it('is 40 bytes on x64 and 28 on x86', () => {
    // x64: DWORD type (4) + 4 padding + a 32-byte union (MOUSEINPUT: five DWORDs
    // then an 8-aligned ULONG_PTR). x86: 4 + 24, no padding.
    expect(inputSize(8)).toBe(40)
    expect(inputSize(4)).toBe(28)
  })

  it('agrees with koffi, which is what actually reads the bytes', () => {
    // Runs on Linux too: koffi's struct arithmetic is host-ABI, and both are LP64/
    // 32-bit-x86 in the same way for these types. If this ever disagrees, the
    // hand-rolled buffer is the thing that is wrong.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require('koffi')
    const KEYBDINPUT = koffi.struct('CLIPMD_KEYBDINPUT', {
      wVk: 'uint16',
      wScan: 'uint16',
      dwFlags: 'uint32',
      time: 'uint32',
      dwExtraInfo: 'uintptr_t'
    })
    const MOUSEINPUT = koffi.struct('CLIPMD_MOUSEINPUT', {
      dx: 'int32',
      dy: 'int32',
      mouseData: 'uint32',
      dwFlags: 'uint32',
      time: 'uint32',
      dwExtraInfo: 'uintptr_t'
    })
    const INPUT = koffi.struct('CLIPMD_INPUT', {
      type: 'uint32',
      u: koffi.union('CLIPMD_INPUT_U', { mi: MOUSEINPUT, ki: KEYBDINPUT })
    })
    const pointerSize = koffi.sizeof('void *') as number
    expect(koffi.sizeof(INPUT)).toBe(inputSize(pointerSize))
  })

  it('writes type, wVk and the key-up flag where Windows reads them', () => {
    const buf = keyInputs([{ vk: VK.CONTROL }, { vk: VK.V, up: true }], 8)
    const view = new DataView(buf.buffer)
    expect(buf.length).toBe(80)
    expect(view.getUint32(0, true)).toBe(1) // INPUT_KEYBOARD
    expect(view.getUint16(8, true)).toBe(VK.CONTROL) // wVk
    expect(view.getUint32(12, true)).toBe(0) // dwFlags: key down
    expect(view.getUint16(48, true)).toBe(VK.V)
    expect(view.getUint32(52, true)).toBe(0x0002) // KEYEVENTF_KEYUP
  })

  it('leaves wScan at zero — virtual keys, never scan codes', () => {
    // Scan code 0x2F is the PHYSICAL position of V on US QWERTY. The same position
    // is `.` on AZERTY and `K` on Dvorak, so a scan-code paste types a full stop for
    // some users and cannot be reproduced by anyone else.
    const view = new DataView(keyInputs([{ vk: VK.V }], 8).buffer)
    expect(view.getUint16(10, true)).toBe(0)
  })

  it('packs the x86 layout without the alignment padding', () => {
    const view = new DataView(keyInputs([{ vk: VK.V }], 4).buffer)
    expect(view.getUint16(4, true)).toBe(VK.V)
  })
})

describe('pasteStrokes', () => {
  it('defaults to plain Ctrl+V, including for terminals', () => {
    // The Linux rule INVERTS here. conhost and Windows Terminal both paste on plain
    // Ctrl+V, and conhost ignores Ctrl+Shift+V entirely, so porting
    // "terminal => add Shift" would make terminals the one place paste silently
    // fails while the log says "injected".
    for (const exe of [null, 'code.exe', 'windowsterminal.exe', 'conhost.exe', 'cmd.exe', 'powershell.exe']) {
      const { strokes, label } = pasteStrokes(exe)
      expect(label, exe ?? 'unknown').toBe('Ctrl+V')
      expect(strokes.map((s) => [s.vk, !!s.up])).toEqual([
        [VK.CONTROL, false],
        [VK.V, false],
        [VK.V, true],
        [VK.CONTROL, true]
      ])
    }
  })

  it('uses Shift+Insert for the emulators that never learned Ctrl+V', () => {
    // Shift+Insert rather than Ctrl+Shift+V: it works in conhost, Windows Terminal,
    // mintty AND PuTTY, so a wrong guess still pastes.
    for (const exe of ['mintty.exe', 'MinTTY.EXE', 'putty.exe']) {
      expect(pasteStrokes(exe).label).toBe('Shift+Insert')
    }
  })

  it('releases the key in the reverse order it was pressed', () => {
    for (const exe of [null, 'mintty.exe']) {
      const s = pasteStrokes(exe).strokes
      expect(s[0].vk).toBe(s[3].vk)
      expect(s[1].vk).toBe(s[2].vk)
      expect(s[3].up).toBe(true)
    }
  })
})

describe('strayModifierReleases', () => {
  const strokes = pasteStrokes(null).strokes

  it('sends nothing when nothing is held', () => {
    expect(strayModifierReleases(() => false, strokes)).toEqual([])
  })

  it('never blindly releases the Windows key', () => {
    // A LWIN key-up with no intervening key POPS THE START MENU. "Defensively
    // release the modifiers" would therefore open Start on top of the app being
    // pasted into, every single time.
    expect(strayModifierReleases(() => false, strokes).some((s) => s.vk === VK.LWIN)).toBe(false)
  })

  it('releases a genuinely-held modifier', () => {
    const held = strayModifierReleases((vk) => vk === VK.MENU, strokes)
    expect(held).toEqual([{ vk: VK.MENU, up: true }])
  })

  it('does not release a modifier that is part of our own chord', () => {
    // Ctrl is about to be pressed; clearing it first is not stray-key handling, it
    // is undoing our own keystroke.
    const held = strayModifierReleases(() => true, strokes)
    expect(held.some((s) => s.vk === VK.CONTROL)).toBe(false)
    expect(held.map((s) => s.vk)).toEqual([VK.SHIFT, VK.MENU, VK.LWIN, VK.RWIN])
  })

  it('keeps Shift when Shift+Insert is the chord', () => {
    const held = strayModifierReleases(() => true, pasteStrokes('mintty.exe').strokes)
    expect(held.some((s) => s.vk === VK.SHIFT)).toBe(false)
    expect(held.some((s) => s.vk === VK.CONTROL)).toBe(true)
  })
})
