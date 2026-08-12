import { app } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { capabilities } from './capabilities'
import { currentPlatform } from './platform'
import { claudeBin, claudeAvailable } from './claudeBin'
import { helperPath } from './mac/helper'

/**
 * `clipboard.md --doctor` — the Windows analogue of `make doctor`.
 *
 * Windows has no `make`, and a packaged Electron app on Windows has no console to
 * print to either, so the only way to ask an installed build what it thinks it can do
 * is to make the binary answer. It prints one JSON object and exits without opening a
 * window, taking the single-instance lock, or touching the database.
 *
 * CI runs this against the INSTALLED exe and diffs `.capabilities` against a
 * committed file. That file is the contract for what "Windows v1" means: adding a
 * capability without updating it fails the build, and so does losing one.
 */
export interface DoctorReport {
  product: string
  version: string
  platform: string
  arch: string
  electron: string
  packaged: boolean
  paths: Record<string, string>
  binaries: Record<string, string | null>
  capabilities: ReturnType<typeof capabilities>
}

export function doctorReport(): DoctorReport {
  const resources = process.resourcesPath ?? ''
  return {
    product: 'clipboard.md',
    version: app.getVersion(),
    platform: currentPlatform(),
    arch: process.arch,
    electron: process.versions.electron ?? 'unknown',
    packaged: app.isPackaged,
    paths: {
      exe: process.execPath,
      userData: app.getPath('userData'),
      temp: app.getPath('temp'),
      resources
    },
    binaries: {
      // Resolved, not merely named: "we would spawn `claude`" and "we found claude"
      // are different answers, and only the second one means the agent lanes work.
      claude: claudeAvailable() ? claudeBin() : null,
      macHelper: helperPath(),
      // extraResources — its absence is the documented Linux bridge-channel
      // regression, and the one thing verify-package.mjs cannot prove from outside.
      pluginScaffold: existsSync(join(resources, 'plugin', '.claude-plugin', 'marketplace.json'))
        ? join(resources, 'plugin')
        : null
    },
    capabilities: capabilities()
  }
}

/**
 * Print the report on stdout and exit. Never returns.
 *
 * Deliberately does NOT await app.whenReady(). Everything here is available before
 * the app is ready, and waiting would make --doctor need a display: on a headless
 * box Electron fails ozone platform init and dies with SIGTRAP before our code runs
 * again, so the diagnostic would be unavailable in exactly the environment (CI, a
 * remote session) where you most want to ask.
 */
export function runDoctor(): void {
  process.stdout.write(JSON.stringify(doctorReport(), null, 2) + '\n')
  app.exit(0)
}
