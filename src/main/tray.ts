import { Menu, Tray, nativeImage } from 'electron'
import { getSettings, updateSettings } from './settings'
import { openSettingsWindow, showPalette } from './windows'
import { MACOS } from './platform'
import { enrichmentOutage, onEnrichmentStatus } from './enrichment'
import { providerProblems, onProviderProblems } from './modelport'


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
 * The clipboard glyph, pre-rendered to 44x44 PNG and inlined as base64.
 *
 * This used to be an SVG string rasterised with sharp at startup. That CRASHES on
 * Linux: sharp's SVG loader is librsvg, and librsvg inside Electron's process hits a
 * GLib/GTK conflict that takes the process down with SIGSEGV (verified: exit 139 from
 * `sharp(svgBuffer).png().toBuffer()` under the Electron binary, while the identical
 * call under system node, and sharp's RAW->PNG path under Electron, both succeed).
 *
 * The failure mode was maximally quiet: the promise never settled, so `new Tray()` was
 * never reached, nothing was logged, and the app carried on with no menu bar icon and
 * no evidence of why. Pre-rendering removes sharp and librsvg from the startup path
 * altogether — nativeImage decodes PNG natively.
 *
 * Two variants because the colour is NOT cosmetic. macOS wants black, since template
 * mode (below) makes it invert to suit a light or dark menu bar. Linux has no template
 * concept — setTemplateImage is a no-op there and the PNG is drawn literally — so a
 * black glyph on GNOME's top bar, which is dark in every theme, is black-on-black:
 * present, clickable and invisible (measured: mean luminance 0.0 over 397 opaque px).
 *
 * To regenerate, run under SYSTEM node (not Electron), from the repo root:
 *   node -e "const s=require('sharp');const svg=c=>\`<svg xmlns='http://www.w3.org/2000/svg' width='22' height='22' viewBox='0 0 22 22'><g fill='none' stroke='\${c}' stroke-width='1.5' stroke-linejoin='round'><rect x='5' y='4' width='12' height='15' rx='2'/><path d='M8.5 4.5h5a1 1 0 0 0 1-1v-.2a1 1 0 0 0-1-1h-5a1 1 0 0 0-1 1v.2a1 1 0 0 0 1 1z' fill='\${c}'/><path d='M8 10h6M8 13.5h4' stroke-linecap='round'/></g></svg>\`;(async()=>{for(const c of['black','white'])console.log(c,(await s(Buffer.from(svg(c))).resize(44,44).png({compressionLevel:9,palette:true}).toBuffer()).toString('base64'))})()"
 */
const ICON_BLACK_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAACwAAAAsCAMAAAApWqozAAAAqFBMVEVMaXEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAARyDi1AAAAN3RSTlMAXQRD3QFcgIh38MwhRZP4Zfu0cu8vc0QFPJIgcZR/CIG5B7e1s84u7C0x29DPQveVzSLR6yvazbGacgAAAAlwSFlzAAALEwAACxMBAJqcGAAAANhJREFUOMvllMcWgjAQRQOYACJFxQ723vv7/z+TFVIGdMHCcnfJuYs3k5zH2CcyGBqlEKM/znP5CDEmPEc2kUDJVGWzlpRnLZl2G1sQbDqka4PEXqTd9g5wrWk16lVr1hKYy9RsboWxiqOFOMG5V6ambAJdKp0F1FOXKqBSMnn/JzIXegTBc2Up/tRScTIXWoQXMT5udYK/lKXYJoqUn6t7I8YP/+esKvCpKmgB117aPQcls0/X1x0o+3qCY+CeiCLtZBTjYUWluxmUe1lnlLniaQk8RWbfzQNcnU4kamA+agAAAABJRU5ErkJggg=='
const ICON_WHITE_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAACwAAAAsCAMAAAApWqozAAAAqFBMVEVMaXH///////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////8ewE1eAAAAN3RSTlMAXARD3QFdgIh38MwhRZP4ZftytO8vc0Q8kiAFcZR/CIG5B7e1s+wtMdvQz84uQs0i0feV6yva07tQYgAAAAlwSFlzAAALEwAACxMBAJqcGAAAANdJREFUOMvllMcWgjAQRQMYOlhAwd57r+///0xWSBnQBQvUu0vOXbyZ5DzGyshwZFRCjMEkz+VjxJjyHNlCAilTFS0nKc89kXabGxCsfdKtgqS6T7vdLeDas3rUqzv2AtiJ1GyuyZhZU0NqwbmjU1O2gDaVzgYaqUsFUCiZvP8TmQtaBIHnynL8qeXiZC6oEd7EKN3qBP5WlmObKFJ+re6DGD/8n7OqoE9VgQfcOmn3FJTMIV1fD0DvawmugXskitTPKMbLkkp3Nyj3vMooc6mnJuhJIvtunnUpTiSkrTdoAAAAAElFTkSuQmCC'

/**
 * Decode the glyph. Tagged scaleFactor 2 so the 44x44 bitmap reads as a 22pt icon and
 * stays crisp on Retina.
 */
function trayIcon(): Electron.NativeImage {
  const b64 = MACOS ? ICON_BLACK_B64 : ICON_WHITE_B64
  const img = nativeImage.createFromBuffer(Buffer.from(b64, 'base64'), { scaleFactor: 2 })
  // Template mode is what makes macOS invert it for a dark menu bar. It is ignored on
  // Linux, which is exactly why the glyph itself has to be the right colour there.
  if (MACOS) img.setTemplateImage(true)
  return img
}

export function buildTrayMenu(): void {
  if (!tray) return
  const settings = getSettings()
  // Accelerator labels teach the hotkeys, but only macOS gets ⌘⇧ combos — on
  // Linux the real bindings are GNOME-level ⌃⌥ ones the Menu API can't render.
  const acc = (mac: string): { accelerator?: string } =>
    MACOS ? { accelerator: mac } : {}
  // A dead key or model used to fail silently for weeks; say so where it is seen.
  const outage = enrichmentOutage()
  const aiProblem = outage ? `AI tagging paused: ${outage}` : providerProblems()[0]
  const menu = Menu.buildFromTemplate([
    ...(aiProblem ? [{ label: aiProblem, enabled: false }, { type: 'separator' as const }] : []),
    { label: 'Open clipboard palette', ...acc('Cmd+Shift+V'), click: () => showPalette() },
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
      aiProblem ?? null
    ]
      .filter(Boolean)
      .join(' — ')
  )
}

export function createTray(): void {
  if (tray) return
  try {
    const icon = trayIcon()
    if (icon.isEmpty()) throw new Error('tray icon failed to decode')
    tray = new Tray(icon)
    buildTrayMenu()
    onEnrichmentStatus(buildTrayMenu)
    onProviderProblems(buildTrayMenu)
    // Log the success too. The previous version logged only failures, so when the
    // icon silently never appeared there was nothing to distinguish "created fine"
    // from "never got there" — which is exactly what happened.
    console.log('[tray] menu bar icon created')
    // No click handler: setContextMenu already opens the menu on left click, and
    // adding one on top summoned the palette AND the menu together.
  } catch (err) {
    // A missing tray must never be fatal — on Linux the appindicator support is
    // genuinely flaky (docs/DESIGN.md §6), and the app works fine without it.
    console.error('[tray] could not create the tray icon:', err)
    tray = null
  }
}

export function destroyTray(): void {
  tray?.destroy()
  tray = null
}
