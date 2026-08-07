import { app } from 'electron'
import { execFile } from 'child_process'
import { existsSync, rmSync, statSync } from 'fs'
import { join } from 'path'
import { portalScreenshot } from './portal'

/**
 * Interactive region capture, per platform.
 *
 * Returns the path of a PNG on disk, or null when the user cancelled. Callers feed
 * that to `capture.ingestImageFile`, so both platforms take the same route into the
 * store — no clipboard round trip, and no separate ingest path to keep in sync.
 *
 * There were two call sites invoking the Linux portal directly (ipc.ts and the
 * hotkey action in index.ts); this exists so the platform choice is made once.
 */

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
function macScreenshot(): Promise<string | null> {
  return new Promise((resolve) => {
    const path = shotPath()
    execFile('screencapture', ['-i', '-o', path], { timeout: 120_000 }, (err) => {
      if (err) {
        // A timeout leaves the picker up; nothing useful to do but report it.
        console.error('[screenshot] screencapture failed:', err.message)
        rmSync(path, { force: true })
        resolve(null)
        return
      }
      if (!existsSync(path) || statSync(path).size === 0) {
        rmSync(path, { force: true })
        resolve(null)
        return
      }
      resolve(path)
    })
  })
}

export async function takeScreenshot(): Promise<string | null> {
  if (process.platform === 'darwin') return macScreenshot()
  return portalScreenshot()
}
