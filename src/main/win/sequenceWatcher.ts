import { existsSync } from 'fs'
import { join } from 'path'

/**
 * Windows clipboard-change detection, and the "don't record this" markers that ride
 * along with it.
 *
 * These are one unit on purpose. Shipping the watcher without the concealed-format
 * read would give Windows a clipboard manager that records every password a manager
 * copies, while Settings displays an ignore list that suggests otherwise — the
 * shape of failure this whole port is trying not to repeat, applied to the one
 * feature where getting it wrong writes secrets to disk.
 */

/** One line from the sidecar. */
export interface WatchEvent {
  sequence: number
  /**
   * True when the clipboard carries any of the markers an application sets to say
   * "do not put this in a clipboard history".
   *
   * Three separate names because they are honoured by different consumers and no
   * application sets all three: ExcludeClipboardContentFromMonitorProcessing is the
   * one third-party managers have honoured for years, CanIncludeInClipboardHistory
   * and CanUploadToCloudClipboard are what Windows' own clipboard history reads.
   * Any of them means the same thing to us.
   */
  concealed: boolean
}

/**
 * Parse a sidecar line, or null when it is not one.
 *
 * Tolerant by construction: PowerShell can emit a banner, a progress record, or a
 * warning about an unsigned profile onto stdout before our first line, and a strict
 * parser would treat that as a clipboard event with sequence NaN.
 */
export function parseWatchLine(line: string): WatchEvent | null {
  const parts = line.trim().split(/\s+/)
  if (parts[0] !== 'CLIP' || parts.length < 5) return null
  const sequence = Number(parts[1])
  if (!Number.isFinite(sequence)) return null
  // `CanIncludeInClipboardHistory` and `CanUploadToCloudClipboard` are OPT-OUT
  // markers: their presence at all is the signal, and their (unread) payload byte
  // carries the yes/no. Treating presence as "concealed" is the safe direction —
  // the cost of a false positive is one clip missing from history, and the cost of
  // a false negative is a password on disk.
  const concealed = parts[2] === '1' || parts[3] === '1' || parts[4] === '1'
  return { sequence, concealed }
}

/** Where clipwatch.ps1 lives: extraResources in a packaged build, the repo in dev. */
export function watcherScript(resourcesPath: string, dirname: string): string | null {
  for (const p of [
    join(resourcesPath, 'win', 'clipwatch.ps1'),
    join(dirname, '..', '..', 'resources', 'win', 'clipwatch.ps1')
  ]) {
    if (existsSync(p)) return p
  }
  return null
}

/**
 * The command line for the sidecar.
 *
 * `powershell.exe` and not `pwsh`: PowerShell 7 is not installed by default and this
 * script uses nothing newer than 5.1. `-ExecutionPolicy Bypass` because the default
 * policy on a fresh Windows install blocks unsigned local scripts outright, and we
 * are not going to sign a 60-line poller. `-NoProfile` because a user profile can
 * print a banner (which would land in our line protocol) and can take a second to
 * load. `-NonInteractive` so a prompt can never wedge it invisibly.
 */
export function watcherCommand(script: string): { cmd: string; args: string[] } {
  return {
    cmd: 'powershell.exe',
    args: [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      script
    ]
  }
}
