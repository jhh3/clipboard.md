import { execFile } from 'child_process'
import { macFrontmost } from '../mac/helper'

/**
 * Best-effort "which app did this copy come from".
 *
 * This is what makes the password-manager ignore-list real: without it,
 * `runFilters` had a `sourceApp` that was never populated, so the shipped
 * 1Password/KeePassXC/Bitwarden ignore list silently did nothing.
 *
 * Wayland deliberately hides the focused window from other clients, so on Linux we
 * ask GNOME Shell over D-Bus when it will answer, and fall back to the X11 active
 * window (correct for Xwayland apps, which includes most password managers today).
 * Returns undefined when it genuinely can't tell — callers must treat unknown as
 * "not ignored" rather than blocking capture.
 */

const TIMEOUT_MS = 400

function run(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: TIMEOUT_MS, encoding: 'utf8' }, (err, stdout) =>
      resolve(err ? null : stdout.trim())
    )
  })
}

async function linuxActiveApp(): Promise<string | undefined> {
  // xprop path: _NET_ACTIVE_WINDOW -> WM_CLASS of that window.
  const active = await run('xprop', ['-root', '_NET_ACTIVE_WINDOW'])
  const id = active?.match(/(0x[0-9a-f]+)/i)?.[1]
  if (!id || id === '0x0') return undefined
  const cls = await run('xprop', ['-id', id, 'WM_CLASS'])
  const m = cls?.match(/"([^"]+)",\s*"([^"]+)"/)
  return m ? m[2] || m[1] : undefined
}

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
    if (process.platform === 'darwin') {
      const front = await macFrontmost()
      if (!front) return undefined
      // Prefer the localized name for display, but never return an empty string — a
      // bundle id is a worse label than a name and a much better one than nothing.
      const name = front.name || front.bundleId
      return name ? { name, id: front.bundleId || undefined } : undefined
    }
    if (process.platform === 'linux') {
      const name = await linuxActiveApp()
      return name ? { name } : undefined
    }
  } catch {
    /* best effort only */
  }
  return undefined
}
