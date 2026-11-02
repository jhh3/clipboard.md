import { macFrontmost } from '../mac/helper'
import { activeWmClass } from '../xconn'
import { MACOS, LINUX } from '../platform'

/**
 * Best-effort "which app did this copy come from".
 *
 * This is what makes the password-manager ignore-list real: without it,
 * `runFilters` had a `sourceApp` that was never populated, so the shipped
 * 1Password/KeePassXC/Bitwarden ignore list silently did nothing.
 *
 * Wayland deliberately hides the focused window from other clients, so on Linux this
 * is the X11 active window's WM_CLASS, read over the shared X connection (correct for
 * Xwayland apps, which includes most password managers today).
 * Returns undefined when it genuinely can't tell — callers must treat unknown as
 * "not ignored" rather than blocking capture.
 */

export interface SourceApp {
  /** Human-readable, for display: "1Password", "Safari", "firefox". */
  name: string
  /** macOS bundle id when we have one — a far more reliable key for ignore rules. */
  id?: string
}

/**
 * On darwin this used to take an optional helper path that no caller ever passed, so
 * `getSourceApp()` returned undefined unconditionally and the ignore list was as dead
 * on macOS as it had been on Linux before xprop. The helper module now resolves its
 * own path, so there is nothing for a caller to forget.
 */
export async function getSourceApp(): Promise<SourceApp | undefined> {
  try {
    if (MACOS) {
      const front = await macFrontmost()
      if (!front) return undefined
      // Prefer the localized name for display, but never return an empty string — a
      // bundle id is a worse label than a name and a much better one than nothing.
      const name = front.name || front.bundleId
      return name ? { name, id: front.bundleId || undefined } : undefined
    }
    if (LINUX) {
      const name = await activeWmClass()
      return name ? { name } : undefined
    }
  } catch {
    /* best effort only */
  }
  return undefined
}
