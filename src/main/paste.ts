import { BrowserWindow, nativeImage, Notification } from 'electron'
import { readFileSync } from 'fs'
import {
  writeClipboardText,
  writeClipboardImage,
  writeClipboardHtml,
  markOwnedByUs,
  waitForClipboard,
  waitForClipboardImage
} from './capture/clipboardIO'
import type { ClipItem, PasteOutcome } from '@shared/types'
import type { CaptureService } from './capture'
import { getItem } from './store/items'
import { getSettings } from './settings'
import { focusedWmClass, getDictationTarget, isTerminalClass } from './focusedWindow'
import { macFrontmost, macPaste } from './mac/helper'
import { activeWindow, armActiveWindowChange, xReady } from './xconn'
import { MACOS, LINUX } from './platform'

/**
 * Destination-aware paste: we know what the paste target will be before we touch the
 * clipboard, so the payload can be adapted to it.
 *
 * On macOS the palette is a non-activating panel, so the frontmost app AT PASTE TIME
 * is the target. (Linux shapes the keystroke instead: Ctrl+Shift+V for terminals.)
 *
 * Two rules, both boring on purpose:
 *  - terminals get plain text (rich-text paste into a terminal is never wanted)
 *  - chat apps get code clips fenced, so they arrive as code blocks
 */
export type DestinationRole = 'terminal' | 'chat' | null

/** macOS bundle identifiers. */
const TERMINAL_BUNDLES = new Set([
  'com.apple.Terminal',
  'com.googlecode.iterm2',
  'dev.warp.Warp-Stable',
  'net.kovidgoyal.kitty',
  'org.alacritty',
  'com.github.wez.wezterm',
  'com.mitchellh.ghostty'
])
const CHAT_BUNDLES = new Set(['com.tinyspeck.slackmacgap', 'com.hnc.Discord'])

/**
 * What kind of destination this is, from a platform-appropriate identifier.
 *
 * Pure and platform-parameterised so the table can be tested anywhere.
 */
export function destinationRole(id: string | null, platform: string): DestinationRole {
  if (!id || platform !== 'darwin') return null
  if (TERMINAL_BUNDLES.has(id)) return 'terminal'
  if (CHAT_BUNDLES.has(id)) return 'chat'
  return null
}

interface PasteShaping {
  plain: boolean
  /** Replacement text content (e.g. fenced code), when the destination wants one. */
  text?: string
}

export function shapeForDestination(
  item: ClipItem,
  plain: boolean,
  role: DestinationRole,
  smartPaste: boolean
): PasteShaping {
  if (!role || !smartPaste) return { plain }
  if (role === 'terminal') return { plain: true }
  if (role === 'chat' && item.kind === 'code' && !plain) {
    // Already fenced? Leave it alone.
    if (!item.content.trimStart().startsWith('```')) {
      const lang = item.language ?? ''
      return { plain: true, text: `\`\`\`${lang}\n${item.content}\n\`\`\`` }
    }
  }
  return { plain }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * How long to wait after hiding our window before injecting the paste keystroke, where
 * there is no focus event to wait on instead. Focus has to land back on the target
 * window before the keystroke arrives, or it goes nowhere. macOS hands focus back
 * fast, and the helper adds its own 30ms drain after posting. On Linux this is only
 * the fallback for a session without an X connection; see waitForFocusBack.
 */
const FOCUS_SETTLE_MS = MACOS ? 120 : 300

/** Upper bound on waiting for _NET_ACTIVE_WINDOW to move off our hidden window. */
const FOCUS_EVENT_TIMEOUT_MS = 250
/**
 * After focus leaves us, _NET_ACTIVE_WINDOW can read 0 for a moment before naming the
 * target (or stays 0 for good when the target is a native Wayland window). This is how
 * long we give it to name one.
 */
const FOCUS_ZERO_GRACE_MS = 60

/**
 * Wait until focus has really gone back to the target after we hide.
 *
 * This replaced a fixed 300ms sleep. Two cases:
 *  - We never had focus (dictation: the HUD is focusable:false and shown inactive), so
 *    the target already has it and there is nothing to wait for.
 *  - The palette had focus: wait for mutter to change _NET_ACTIVE_WINDOW, which it does
 *    in the same step that moves keyboard focus. Typically 20-60ms.
 */
async function waitForFocusBack(hadFocus: boolean, hide: () => void): Promise<void> {
  if (!hadFocus) {
    hide()
    return
  }
  if (!xReady()) {
    hide()
    await sleep(FOCUS_SETTLE_MS)
    return
  }
  const arm = armActiveWindowChange()
  try {
    hide()
    if (!(await arm.wait(FOCUS_EVENT_TIMEOUT_MS))) return
    if ((await activeWindow()) === 0) await arm.wait(FOCUS_ZERO_GRACE_MS)
  } finally {
    arm.cancel()
  }
}

/**
 * Paste tiers (see docs/DESIGN.md §2):
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
  private async setClipboard(itemId: number, plain: boolean, forPaste = false): Promise<boolean> {
    const item = getItem(itemId)
    if (!item) return false
    // Only shape when a paste follows: a plain copy (⌘↵) must put the item on the
    // clipboard verbatim — the user may be heading anywhere with it. Gated on the
    // setting BEFORE the helper call: with the toggle off (or the helper broken),
    // the hottest path in the app must not pay a helper round-trip.
    const smart = getSettings().smartPaste !== false
    // macOS asks the helper; Linux shapes the keystroke instead (see deliver).
    const destId = forPaste && smart && MACOS ? ((await macFrontmost())?.bundleId ?? null) : null
    const shaped = shapeForDestination(item, plain, destinationRole(destId, 'darwin'), smart)
    const text = shaped.text ?? item.content
    markOwnedByUs()
    if (item.kind === 'image') {
      this.capture.markSelfWrite()
      const png = readFileSync(item.content)
      await writeClipboardImage(png)
      // pasteItem treats `true` here as "the clipboard holds it" and injects Ctrl+V;
      // injecting before the write lands pastes the previous clip.
      if (!(await waitForClipboardImage(png))) {
        console.error('[paste] clipboard did not take the image write in time')
        return false
      }
    } else if (item.html && !shaped.plain && !LINUX) {
      // Linux cannot publish HTML and plain text at once (see writeClipboardHtml), and
      // routing here also skipped the waitForClipboard guard below — so a rich clip
      // was both unpastable and unverified.
      this.capture.markSelfWrite(item.content)
      await writeClipboardHtml(item.html, item.content)
    } else {
      this.capture.markSelfWrite(text)
      await writeClipboardText(text)
      // Don't inject a paste until the selection really holds this text.
      if (!(await waitForClipboard(text))) {
        console.error('[paste] clipboard did not take ownership in time')
        return false
      }
    }
    return true
  }

  /** Returns false when the text never reached the selection — see the guard below. */
  async setClipboardRaw(output: string, outputKind: 'text' | 'image'): Promise<boolean> {
    markOwnedByUs()
    if (outputKind === 'image') {
      this.capture.markSelfWrite()
      const png = nativeImage.createFromDataURL(output).toPNG()
      await writeClipboardImage(png)
      // Verified for the same reason the text branch below is: this return value is
      // what decides whether a paste keystroke is injected.
      if (!(await waitForClipboardImage(png))) {
        console.error('[paste] clipboard did not take the image write in time')
        return false
      }
      return true
    }
    this.capture.markSelfWrite(output)
    await writeClipboardText(output)
    // The same guard setClipboard() has, and for the same reason: the write goes to
    // a detached owner process, so returning before it actually holds the X selection
    // means the Ctrl+V we are about to inject pastes whatever was on the clipboard
    // BEFORE this dictation. That is precisely the "it pasted the last thing I
    // copied" failure — silent, because every step reported success.
    if (!(await waitForClipboard(output))) {
      console.error('[paste] clipboard did not take ownership in time')
      return false
    }
    return true
  }

  async pasteItem(itemId: number, plain: boolean): Promise<PasteOutcome> {
    const t0 = Date.now()
    const portal = this.preparePortal()
    const item = getItem(itemId)
    console.log(
      `[paste] item ${itemId} kind=${item?.kind ?? 'missing'} chars=${item?.content.length ?? 0}` +
        `${item?.html ? ' html' : ''}${plain ? ' plain' : ''}`
    )
    if (!(await this.setClipboard(itemId, plain, true))) {
      // These are two different failures and they used to share one message, so a
      // clipboard that never took ownership was reported as a deleted item.
      const reason = getItem(itemId) ? 'clipboard write failed' : 'Item no longer exists'
      console.error(`[paste] item ${itemId} not pasted: ${reason}`)
      return { method: 'copied', message: reason }
    }
    return this.deliver(t0, portal)
  }

  async pasteRaw(output: string, outputKind: 'text' | 'image'): Promise<PasteOutcome> {
    const t0 = Date.now()
    const portal = this.preparePortal()
    // Injecting Ctrl+V when the clipboard write did not land would paste the PREVIOUS
    // clipboard entry into whatever the user is typing in — worse than not pasting.
    if (!(await this.setClipboardRaw(output, outputKind))) {
      return { method: 'copied', message: 'Copied — press Ctrl+V to paste' }
    }
    return this.deliver(t0, portal)
  }

  /**
   * Start the portal session the moment a paste begins, so its handshake overlaps the
   * clipboard write and the focus hand-back rather than following them. Lazily
   * imported: portal.ts pulls in dbus-next, which macOS never needs.
   */
  private preparePortal(): Promise<boolean> | null {
    if (!LINUX || getSettings().pasteInjection !== 'portal') return null
    return import('./portal').then((m) => m.preparePortal())
  }

  async copyItem(itemId: number): Promise<void> {
    await this.setClipboard(itemId, false)
  }

  private async deliver(t0: number, portalReady: Promise<boolean> | null): Promise<PasteOutcome> {
    if (MACOS) {
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
    if (portalReady) {
      const tClip = Date.now()
      const hadFocus = BrowserWindow.getFocusedWindow() !== null
      // Focus hand-back and portal readiness are independent; wait for both at once.
      let tFocus = 0
      let tPortal = 0
      await Promise.all([
        waitForFocusBack(hadFocus, this.hideWindow).then(() => (tFocus = Date.now())),
        portalReady.then(() => (tPortal = Date.now()))
      ])
      // Asked only AFTER focus is back: before that the focused window is still ours,
      // and we would be shaping the keystroke for the palette instead of for whatever
      // the user is actually typing into. The app recorded at dictation start is the
      // fallback (a native Wayland window has no X11 class to read). Guessing wrong
      // costs the whole paste — a plain Ctrl+V in a terminal does nothing at all.
      const dest = (await focusedWmClass()) ?? getDictationTarget()
      const shift = isTerminalClass(dest)
      const { portalPaste } = await import('./portal')
      const tKeys = Date.now()
      const ok = await portalPaste(shift)
      const end = Date.now()
      console.log(
        `[timing] paste ${end - t0}ms (clipboard=${tClip - t0} focus=${tFocus - tClip}` +
          `${hadFocus ? '' : '/none'} portal=${tPortal - tClip} keys=${end - tKeys})`
      )
      if (ok) {
        console.log(`[paste] injected via portal (${shift ? 'Ctrl+Shift+V' : 'Ctrl+V'}${dest ? ` → ${dest}` : ''})`)
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
