import { Menu, Tray, nativeImage } from 'electron'
import { getSettings, updateSettings } from './settings'
import { unreadCount } from './agents'
import { openAgentsWindow, openNotesWindow, openSettingsWindow, showPalette } from './windows'


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

/**
 * Rasterise the glyph to a PNG.
 *
 * nativeImage does NOT decode SVG — createFromDataURL on an SVG returns an empty
 * 0x0 image, and `new Tray()` with that is an invisible menu bar item with no error
 * anywhere. Verified. sharp is already a dependency, so render it once at startup.
 *
 * Drawn at 2x and tagged scaleFactor 2 so it is crisp on Retina.
 */
async function trayIcon(): Promise<Electron.NativeImage> {
  const sharp = (await import('sharp')).default
  const png = await sharp(Buffer.from(ICON_SVG)).resize(44, 44).png().toBuffer()
  const img = nativeImage.createFromBuffer(png, { scaleFactor: 2 })
  // Template mode is what makes macOS invert it for a dark menu bar. On Linux the
  // flag is ignored, and the plain glyph is what we want anyway.
  img.setTemplateImage(true)
  return img
}

export function buildTrayMenu(): void {
  if (!tray) return
  const settings = getSettings()
  // Unread agent messages are the one thing worth surfacing on the icon itself:
  // an agent blocked on a question is waiting on the user without any other signal.
  let unread = 0
  try {
    unread = unreadCount()
  } catch {
    /* database not open yet during early startup */
  }
  // Accelerator labels teach the hotkeys, but only macOS gets ⌘⇧ combos — on
  // Linux the real bindings are GNOME-level ⌃⌥ ones the Menu API can't render.
  const acc = (mac: string): { accelerator?: string } =>
    process.platform === 'darwin' ? { accelerator: mac } : {}
  const menu = Menu.buildFromTemplate([
    { label: 'Open clipboard palette', ...acc('Cmd+Shift+V'), click: () => showPalette() },
    { type: 'separator' },
    { label: 'Notes…', ...acc('Cmd+Shift+N'), click: () => openNotesWindow() },
    {
      label: "Today's note",
      click: () => {
        // Resolved lazily so the daily note is created on demand, not at launch.
        void import('./store/notes').then(({ dailyNote }) => openNotesWindow(dailyNote()))
      }
    },
    {
      label: unread > 0 ? `Agent inbox (${unread})` : 'Agent inbox',
      ...acc('Cmd+Shift+A'),
      click: () => openAgentsWindow()
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
    { label: 'Settings…', ...acc('Cmd+,'), click: () => openSettingsWindow() },
    { type: 'separator' },
    { label: 'Quit clipboard.md', role: 'quit' }
  ])
  tray.setContextMenu(menu)
  tray.setToolTip(
    [
      'clipboard.md',
      settings.captureEnabled ? null : 'capture paused',
      unread > 0 ? `${unread} unread from agents` : null
    ]
      .filter(Boolean)
      .join(' — ')
  )
  // macOS shows this next to the icon; it is how a blocked agent gets noticed.
  tray.setTitle(unread > 0 ? String(unread) : '')
}

export async function createTray(): Promise<void> {
  if (tray) return
  try {
    const icon = await trayIcon()
    if (icon.isEmpty()) throw new Error('tray icon failed to rasterise')
    tray = new Tray(icon)
    buildTrayMenu()
    // NO click handler. setContextMenu already makes macOS open the menu on left
    // click; adding one on top of that summoned the palette AND the menu together,
    // overlapping each other. The menu is what a menu bar icon is for — the palette
    // has its own hotkey and a menu entry.
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
