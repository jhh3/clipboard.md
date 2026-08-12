import { app } from 'electron'
import { execFile } from 'child_process'
import { existsSync, rmSync, statSync } from 'fs'
import { join } from 'path'
import { MACOS, LINUX } from './platform'

/**
 * Interactive region capture, per platform.
 *
 * Callers feed the resulting PNG path to `capture.ingestImageFile`, so every
 * platform takes the same route into the store — no clipboard round trip, and no
 * separate ingest path to keep in sync.
 *
 * The result is a discriminated union rather than `string | null`, because "the user
 * pressed Esc" and "this platform cannot do this" are different facts and the UI has
 * to say different things about them. They used to share `null`, and on Windows —
 * which fell into the Linux portal branch and got a D-Bus error — the app reported
 * "Capture cancelled" for a capture the user never started, let alone cancelled.
 */
export type ScreenshotResult =
  | { path: string }
  /** The user dismissed the picker. Nothing to report; the UI stays quiet. */
  | { cancelled: true }
  /** Not possible here. `reason` is shown to the user, so it must say what to do instead. */
  | { unavailable: string }

/** Temp path for a capture. Not in userData: this file is consumed and deleted. */
function shotPath(): string {
  return join(app.getPath('temp'), `clipmd-shot-${Date.now()}.png`)
}

/**
 * macOS: `screencapture -i` gives the system crosshair/window picker. Writing to a
 * file rather than `-c` (clipboard) keeps the flow identical to Linux's and avoids
 * bouncing the image through the pasteboard, which our own capture loop would then
 * race to re-ingest as a separate clip.
 *
 * Cancelling (Esc) exits 0 having written nothing, so existence — not exit code — is
 * what distinguishes a cancel from a capture. Screen Recording permission is a
 * system prompt the first time; without it macOS writes a blank or missing file, and
 * that also lands here as "cancelled".
 */
function macScreenshot(): Promise<ScreenshotResult> {
  return new Promise((resolve) => {
    const path = shotPath()
    execFile('screencapture', ['-i', '-o', path], { timeout: 120_000 }, (err) => {
      if (err) {
        // A timeout leaves the picker up; nothing useful to do but report it.
        console.error('[screenshot] screencapture failed:', err.message)
        rmSync(path, { force: true })
        resolve({ cancelled: true })
        return
      }
      if (!existsSync(path) || statSync(path).size === 0) {
        rmSync(path, { force: true })
        resolve({ cancelled: true })
        return
      }
      resolve({ path })
    })
  })
}

export async function takeScreenshot(): Promise<ScreenshotResult> {
  if (MACOS) return macScreenshot()
  if (LINUX) {
    // Imported lazily. portal.ts pulls in dbus-next and opens a session bus at
    // module load, and this module is imported at startup by ipc.ts — so a
    // top-level import loaded the entire Linux-only D-Bus stack on every Windows
    // boot, to reach code that can never run there.
    const { portalScreenshot } = await import('./portal')
    const path = await portalScreenshot()
    return path ? { path } : { cancelled: true }
  }
  // Explicitly NOT the Linux branch. See capabilities.ts.
  return { unavailable: 'Region capture is not available on this platform yet.' }
}
