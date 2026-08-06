import { clipboard, nativeImage } from 'electron'
import { execFile } from 'child_process'
import { join } from 'path'
import type { PasteOutcome } from '@shared/types'
import type { CaptureService } from './capture'
import { getItem } from './store/items'

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

  private setClipboard(itemId: number, plain: boolean): boolean {
    const item = getItem(itemId)
    if (!item) return false
    if (item.kind === 'image') {
      this.capture.markSelfWrite()
      clipboard.writeImage(nativeImage.createFromPath(item.content))
    } else if (item.html && !plain) {
      this.capture.markSelfWrite(item.content)
      clipboard.write({ text: item.content, html: item.html })
    } else {
      this.capture.markSelfWrite(item.content)
      clipboard.writeText(item.content)
    }
    return true
  }

  setClipboardRaw(output: string, outputKind: 'text' | 'image'): void {
    if (outputKind === 'image') {
      this.capture.markSelfWrite()
      clipboard.writeImage(nativeImage.createFromDataURL(output))
    } else {
      this.capture.markSelfWrite(output)
      clipboard.writeText(output)
    }
  }

  async pasteItem(itemId: number, plain: boolean): Promise<PasteOutcome> {
    if (!this.setClipboard(itemId, plain)) {
      return { method: 'copied', message: 'Item no longer exists' }
    }
    return this.deliver()
  }

  async pasteRaw(output: string, outputKind: 'text' | 'image'): Promise<PasteOutcome> {
    this.setClipboardRaw(output, outputKind)
    return this.deliver()
  }

  copyItem(itemId: number): void {
    this.setClipboard(itemId, false)
  }

  private async deliver(): Promise<PasteOutcome> {
    if (process.platform === 'darwin') {
      this.hideWindow()
      const injected = await this.macInject()
      if (injected) return { method: 'injected' }
      return { method: 'copied', message: 'Copied — press ⌘V to paste' }
    }
    // Linux tier 0: the renderer shows the toast, then hides the window;
    // mutter restores focus to the previous surface on hide.
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
