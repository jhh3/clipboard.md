import { nativeImage, Notification } from 'electron'
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
import { restoreForeground, targetExe } from './win/foreground'
import { sendPaste } from './win/inject'
import { MACOS, LINUX, WIN32 } from './platform'

/**
 * Destination-aware paste: we know what the paste target will be before we touch the
 * clipboard, so the payload can be adapted to it.
 *
 * On macOS the palette is a non-activating panel, so the frontmost app AT PASTE TIME
 * is the target. On Windows there is no such panel — we take focus — so the target is
 * the window remembered before we showed ourselves (win/foreground.ts).
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
 * Windows executable basenames.
 *
 * Without this table the Smart-paste setting is visible in Settings on Windows and
 * changes nothing, which is the same "control that silently does nothing" this port
 * keeps deleting.
 *
 * ApplicationFrameHost.exe is here because a UWP window's foreground process is the
 * frame host rather than the app — it is a terminal only sometimes, and treating it
 * as one costs at worst a rich clip pasted as plain text, which is the safe error.
 */
const TERMINAL_EXES = new Set([
  'windowsterminal.exe',
  'conhost.exe',
  'openconsole.exe',
  'cmd.exe',
  'powershell.exe',
  'pwsh.exe',
  'mintty.exe',
  'putty.exe',
  'wezterm-gui.exe',
  'alacritty.exe',
  'kitty.exe'
])
const CHAT_EXES = new Set(['slack.exe', 'discord.exe', 'teams.exe', 'ms-teams.exe'])

/**
 * What kind of destination this is, from a platform-appropriate identifier.
 *
 * Pure and platform-parameterised so the macOS table can be asserted to produce
 * exactly the results it produced before Windows existed.
 */
export function destinationRole(id: string | null, platform: string): DestinationRole {
  if (!id) return null
  if (platform === 'win32') {
    const exe = id.toLowerCase()
    if (TERMINAL_EXES.has(exe)) return 'terminal'
    if (CHAT_EXES.has(exe)) return 'chat'
    return null
  }
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
 * Tell the user the paste did not happen.
 *
 * The window is already hidden by the time we know, so a renderer toast would never
 * be seen — this is the only channel left. On Windows it only works because
 * index.ts sets an AppUserModelID at startup: without one, `new Notification()` is
 * itself a silent no-op, which would make the message that exists specifically to
 * explain a silent failure fail silently.
 */
function notifyFallback(body: string): void {
  new Notification({ title: 'Copied', body, silent: true }).show()
}

/**
 * How long to wait after hiding our window before injecting the paste keystroke.
 * Focus has to land back on the target window before the keystroke arrives, or it
 * goes nowhere. Linux waits on mutter refocusing the previous surface, and 150ms was
 * too tight on a loaded system. macOS hands focus back faster, and the helper adds its
 * own 30ms drain after posting.
 */
const FOCUS_SETTLE_MS = MACOS ? 120 : 300

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
    // Windows reads the REMEMBERED window, not the current one: by now the current
    // one is us. macOS asks the helper, exactly as before.
    const destId =
      forPaste && smart
        ? MACOS
          ? ((await macFrontmost())?.bundleId ?? null)
          : WIN32
            ? targetExe()
            : null
        : null
    const shaped = shapeForDestination(item, plain, destinationRole(destId, MACOS ? 'darwin' : 'win32'), smart)
    const text = shaped.text ?? item.content
    markOwnedByUs()
    if (item.kind === 'image') {
      this.capture.markSelfWrite()
      const png = readFileSync(item.content)
      await writeClipboardImage(png)
      // The last unverified branch of the three. writeImage is as silently
      // droppable on Windows as writeText (same ScopedClipboardWriter, same five
      // OpenClipboard tries then give up), and pasteItem treats `true` here as "the
      // clipboard holds it" and injects Ctrl+V — pasting the previous clip.
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
      // The richest clips were the only unverified ones. On Windows a write can be
      // dropped silently (see verifyClipboardText), so this branch could hand back
      // success having put nothing on the clipboard — and then inject Ctrl+V, which
      // pastes the previous clip. macOS keeps its existing unverified path.
      if (WIN32 && !(await waitForClipboard(item.content))) {
        console.error('[paste] clipboard did not take the HTML write in time')
        return false
      }
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
    return this.deliver()
  }

  async pasteRaw(output: string, outputKind: 'text' | 'image'): Promise<PasteOutcome> {
    // Injecting Ctrl+V when the clipboard write did not land would paste the PREVIOUS
    // clipboard entry into whatever the user is typing in — worse than not pasting.
    if (!(await this.setClipboardRaw(output, outputKind))) {
      return { method: 'copied', message: 'Copied — press Ctrl+V to paste' }
    }
    return this.deliver()
  }

  async copyItem(itemId: number): Promise<void> {
    await this.setClipboard(itemId, false)
  }

  private async deliver(): Promise<PasteOutcome> {
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

    // Windows, above the pasteInjection check on purpose.
    //
    // `pasteInjection` is a Linux setting: its values name the XDG RemoteDesktop
    // portal, and the stored default is 'portal'. Falling through to that check on
    // Windows meant hiding the window, sleeping 300ms and then calling into D-Bus —
    // a dead path that cost a third of a second and ended in nothing, every time.
    // Interpreting the stored value per-platform is deliberate; RENAMING it would be
    // a settings migration across every existing Linux install, which is exactly the
    // regression shape this port must not create.
    if (WIN32) {
      // Hide first, then put focus back where it was, and only inject once the
      // foreground window really IS the one we remembered. Windows has no
      // non-activating panel and no compositor handing focus back, so this is the
      // hard part — see win/foreground.ts. A bounded poll replaces the fixed sleep
      // the other platforms use, because a sleep cannot tell "focus took 40ms" from
      // "focus never came back", and on Windows the second happens routinely
      // (the foreground lock).
      this.hideWindow()
      if (!(await restoreForeground())) {
        console.error('[paste] focus did not return to the previous window; not injecting')
        return { method: 'copied', message: 'Copied — press Ctrl+V to paste' }
      }
      const { injected, reason } = sendPaste(targetExe())
      if (injected) return { method: 'injected' }
      console.error(`[paste] not injected: ${reason}`)
      notifyFallback(reason ?? 'Press Ctrl+V to paste')
      return { method: 'copied', message: reason ?? 'Copied — press Ctrl+V to paste' }
    }

    // Linux tier 1: hide (mutter refocuses the previous surface), then inject
    // Ctrl+V via the RemoteDesktop portal. First use pops one permission dialog.
    if (getSettings().pasteInjection === 'portal') {
      this.hideWindow()
      await sleep(FOCUS_SETTLE_MS)
      // Asked only AFTER hiding and settling: before that the focused window is still
      // ours, and we would be shaping the keystroke for the palette instead of for
      // whatever the user is actually typing into.
      // Live detection first; the app recorded at dictation start is the fallback.
      // Focus can still be in flight here, and guessing wrong costs the whole paste —
      // a plain Ctrl+V in a terminal does nothing at all.
      const dest = (await focusedWmClass()) ?? getDictationTarget()
      const shift = isTerminalClass(dest)
      // Lazily imported: portal.ts opens a D-Bus session bus at module load, and a
      // top-level import pulled that whole Linux-only stack into every Windows boot.
      const { portalPaste } = await import('./portal')
      if (await portalPaste(shift)) {
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
