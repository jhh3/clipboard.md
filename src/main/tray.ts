import { Menu, Tray, nativeImage } from 'electron'
import { getSettings, updateSettings } from './settings'
import { openNotesWindow, openSettingsWindow, showPalette } from './windows'

/**
 * Menu bar / tray entry point.
 *
 * This app hides its Dock icon and lives behind global hotkeys, which leaves a user
 * who has forgotten the shortcuts with no way to reach it at all — and no evidence it
 * is even running. The menu bar is that evidence, and the discovery surface for
 * everything the hotkeys do.
 *
 * On macOS the icon must be a TEMPLATE image: macOS then tints it for light/dark menu
 * bars automatically. A coloured icon looks broken in one of the two themes, and gets
 * worse with menu bar tinting turned on.
 */

let tray: Tray | null = null

/**
 * A 16pt clipboard glyph as a template image, drawn as an SVG data URL.
 *
 * Inline rather than a bundled asset because it must exist in the packaged app
 * without another extraResources entry to keep in sync, and at 22x22 the alternative
 * is shipping @1x/@2x PNGs for a shape this simple.
 */
const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 22 22">
  <g fill="none" stroke="black" stroke-width="1.5" stroke-linejoin="round">
    <rect x="5" y="4" width="12" height="15" rx="2"/>
    <path d="M8.5 4.5h5a1 1 0 0 0 1-1v-.2a1 1 0 0 0-1-1h-5a1 1 0 0 0-1 1v.2a1 1 0 0 0 1 1z" fill="black"/>
    <path d="M8 10h6M8 13.5h4" stroke-linecap="round"/>
  </g>
</svg>`

function trayIcon(): Electron.NativeImage {
  const img = nativeImage.createFromDataURL(
    `data:image/svg+xml;base64,${Buffer.from(ICON_SVG).toString('base64')}`
  )
  // Template mode is what makes macOS invert it for a dark menu bar. On Linux the
  // flag is ignored, and the plain glyph is what we want anyway.
  img.setTemplateImage(true)
  return img
}

export function buildTrayMenu(): void {
  if (!tray) return
  const settings = getSettings()
  const menu = Menu.buildFromTemplate([
    { label: 'Open clipboard palette', accelerator: 'Cmd+Shift+V', click: () => showPalette() },
    { type: 'separator' },
    { label: 'Notes…', click: () => openNotesWindow() },
    {
      label: "Today's note",
      click: () => {
        // Resolved lazily so the daily note is created on demand, not at launch.
        void import('./store/notes').then(({ dailyNote }) => openNotesWindow(dailyNote()))
      }
    },
    { type: 'separator' },
    {
      // The honest kill switch. A clipboard manager that cannot be paused is one
      // people quit instead — and quitting loses the hotkeys too.
      label: 'Pause capture',
      type: 'checkbox',
      checked: !settings.captureEnabled,
      click: (item) => {
        updateSettings({ captureEnabled: !item.checked })
        buildTrayMenu()
      }
    },
    { label: 'Settings…', accelerator: 'Cmd+,', click: () => openSettingsWindow() },
    { type: 'separator' },
    { label: 'Quit clipboard.md', role: 'quit' }
  ])
  tray.setContextMenu(menu)
  tray.setToolTip(settings.captureEnabled ? 'clipboard.md' : 'clipboard.md — capture paused')
}

export function createTray(): void {
  if (tray) return
  try {
    tray = new Tray(trayIcon())
    buildTrayMenu()
    // Left-click opens the palette on macOS; the context menu still shows on right
    // click. Matching what a menu bar utility is expected to do.
    tray.on('click', () => showPalette())
  } catch (err) {
    // A missing tray must never be fatal — on Linux the appindicator support is
    // genuinely flaky (DESIGN.md §6), and the app works fine without it.
    console.error('[tray] could not create the tray icon:', err)
    tray = null
  }
}

export function destroyTray(): void {
  tray?.destroy()
  tray = null
}
