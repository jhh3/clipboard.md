import { nativeImage, Notification } from 'electron'
import { execFile } from 'child_process'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  writeClipboardText,
  writeClipboardImage,
  writeClipboardHtml,
  markOwnedByUs
} from './capture/clipboardIO'
import type { PasteOutcome } from '@shared/types'
import type { CaptureService } from './capture'
import { getItem } from './store/items'
import { getSettings } from './settings'
import { portalPaste } from './portal'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

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
      this.hideWindow()
      const injected = await this.macInject()
      if (injected) return { method: 'injected' }
      return { method: 'copied', message: 'Copied — press ⌘V to paste' }
    }

    // Linux tier 1: hide (mutter refocuses the previous surface), then inject
    // Ctrl+V via the RemoteDesktop portal. First use pops one permission dialog.
    if (getSettings().pasteInjection === 'portal') {
      this.hideWindow()
      await sleep(150)
      if (await portalPaste()) return { method: 'injected' }
      // Window is already hidden, so the renderer toast won't be seen — use a
      // desktop notification for the fallback hint instead.
      new Notification({ title: 'Copied', body: 'Press Ctrl+V to paste', silent: true }).show()
      return { method: 'injected' } // renderer should not re-toast or re-hide
    }

    // Tier 0: the renderer shows the toast, then hides the window.
    return { method: 'copied', message: 'Copied — press Ctrl+V to paste' }
  }

  private macInject(): Promise<boolean> {
    return new Promise((resolve) => {
      const helper = join(process.resourcesPath ?? '', 'clipmd-helper')
      // Small delay lets focus return to the target app after our window hides.
      setTimeout(() => {
        execFile(helper, ['paste'], { timeout: 3000 }, (err) => resolve(!err))
      }, 120)
    })
  }
}
