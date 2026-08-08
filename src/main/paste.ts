import { nativeImage, Notification } from 'electron'
import { readFileSync } from 'fs'
import {
  writeClipboardText,
  writeClipboardImage,
  writeClipboardHtml,
  markOwnedByUs,
  waitForClipboard
} from './capture/clipboardIO'
import type { PasteOutcome } from '@shared/types'
import type { CaptureService } from './capture'
import { getItem } from './store/items'
import { getSettings } from './settings'
import { portalPaste } from './portal'
import { macPaste } from './mac/helper'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * How long to wait after hiding our window before injecting the paste keystroke.
 * Focus has to land back on the target window before the keystroke arrives, or it
 * goes nowhere. Linux waits on mutter refocusing the previous surface, and 150ms was
 * too tight on a loaded system. macOS hands focus back faster, and the helper adds its
 * own 30ms drain after posting.
 */
const FOCUS_SETTLE_MS = process.platform === 'darwin' ? 120 : 300

/**
 * Paste tiers (see DESIGN.md §2):
 *  - darwin: hide window (focus returns to previous app) → Swift helper posts Cmd+V.
 *  - linux/GNOME tier 0: put content on clipboard, hide, tell the user to Ctrl+V.
 *    Tier 1 (RemoteDesktop portal injection) slots in here once the spike lands.
 */
export class PasteService {
  constructor(
    private capture: CaptureService,
    private hideWindow: () => void
  ) {}

  /**
   * All clipboard writes go through a detached owner process on Linux. Owning the
   * X selection from this process is what froze the desktop: mutter bridges X
   * selections on its single compositor thread, so any moment our UI thread was
   * busy, every paste request in the session stalled behind it (measured: 5511ms
   * with Electron as owner vs 105ms with a dedicated owner process).
   */
  private async setClipboard(itemId: number, plain: boolean): Promise<boolean> {
    const item = getItem(itemId)
    if (!item) return false
    markOwnedByUs()
    if (item.kind === 'image') {
      this.capture.markSelfWrite()
      await writeClipboardImage(readFileSync(item.content))
    } else if (item.html && !plain) {
      this.capture.markSelfWrite(item.content)
      await writeClipboardHtml(item.html, item.content)
    } else {
      this.capture.markSelfWrite(item.content)
      await writeClipboardText(item.content)
      // Don't inject a paste until the selection really holds this text.
      if (!(await waitForClipboard(item.content))) {
        console.error('[paste] clipboard did not take ownership in time')
        return false
      }
    }
    return true
  }

  async setClipboardRaw(output: string, outputKind: 'text' | 'image'): Promise<void> {
    markOwnedByUs()
    if (outputKind === 'image') {
      this.capture.markSelfWrite()
      await writeClipboardImage(nativeImage.createFromDataURL(output).toPNG())
    } else {
      this.capture.markSelfWrite(output)
      await writeClipboardText(output)
    }
  }

  async pasteItem(itemId: number, plain: boolean): Promise<PasteOutcome> {
    if (!(await this.setClipboard(itemId, plain))) {
      return { method: 'copied', message: 'Item no longer exists' }
    }
    return this.deliver()
  }

  async pasteRaw(output: string, outputKind: 'text' | 'image'): Promise<PasteOutcome> {
    await this.setClipboardRaw(output, outputKind)
    return this.deliver()
  }

  async copyItem(itemId: number): Promise<void> {
    await this.setClipboard(itemId, false)
  }

  private async deliver(): Promise<PasteOutcome> {
    if (process.platform === 'darwin') {
      // Hide first: macOS returns key focus to the previously active app, and the
      // ⌘V has to arrive *there*, not at our palette.
      this.hideWindow()
      await sleep(FOCUS_SETTLE_MS)
      const { injected, untrusted } = await macPaste()
      if (injected) return { method: 'injected' }
      // Paste degrades quietly by design, which makes a broken one invisible: the
      // content really is on the clipboard, so nothing throws and nothing logs. Say
      // why we fell back, or the next person debugging this has nothing to go on.
      console.error(
        untrusted
          ? '[paste] not injected: Accessibility permission missing'
          : '[paste] not injected: helper unavailable or failed'
      )
      // Distinguish "we can't" from "we won't": a missing Accessibility grant is
      // fixable by the user, and saying so beats a generic fallback message.
      return {
        method: 'copied',
        message: untrusted
          ? 'Copied — allow clipboard.md under Privacy & Security ▸ Accessibility to paste automatically'
          : 'Copied — press ⌘V to paste'
      }
    }

    // Linux tier 1: hide (mutter refocuses the previous surface), then inject
    // Ctrl+V via the RemoteDesktop portal. First use pops one permission dialog.
    if (getSettings().pasteInjection === 'portal') {
      this.hideWindow()
      await sleep(FOCUS_SETTLE_MS)
      if (await portalPaste()) {
        console.log('[paste] injected via portal')
        return { method: 'injected' }
      }
      // Previously this still reported 'injected', so a failed paste looked
      // identical to a successful one: the window closed and nothing happened.
      // Tell the truth so the UI can say "press Ctrl+V".
      console.error('[paste] portal injection failed; content is on the clipboard')
      // Window is already hidden, so the renderer toast won't be seen — use a
      // desktop notification for the fallback hint instead.
      new Notification({ title: 'Copied', body: 'Press Ctrl+V to paste', silent: true }).show()
      return { method: 'copied', message: 'Copied — press Ctrl+V to paste' }
    }

    // Tier 0: the renderer shows the toast, then hides the window.
    return { method: 'copied', message: 'Copied — press Ctrl+V to paste' }
  }

}
