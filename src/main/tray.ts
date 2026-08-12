import { Menu, Tray, nativeImage } from 'electron'
import { getSettings, updateSettings } from './settings'
import { unreadCount } from './agents'
import {
  openAgentsWindow,
  openNotesWindow,
  openScratchpadWindow,
  openSettingsWindow,
  showPalette
} from './windows'
import { lastDictationId } from './corrections'
import { execFileSync } from 'child_process'
import { nativeTheme } from 'electron'
import { MACOS, WIN32 } from './platform'


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
 * The same glyph as a multi-frame Windows .ico (16/20/24/32/48, PNG-compressed
 * entries).
 *
 * Not the 44x44 bitmap above. Windows asks for a 16px icon in the notification area
 * and a 32px one in the overflow flyout, and downscaling a lone 44px bitmap to 16px
 * with a generic filter turns 1.5px strokes into grey mush. An .ico lets us ship a
 * bitmap rendered AT each size, which is the entire reason the format exists.
 *
 * Regenerate with scripts/make-tray-ico.mjs (run under system node, not Electron —
 * sharp's librsvg loader segfaults inside the Electron process; see the note above).
 */
const ICO_WHITE_B64 =
  'AAABAAUAEBAAAAEAIADvAAAAVgAAABQUAAABACAAGwEAAEUBAAAYGAAAAQAgADkBAABgAgAAICAAAAEAIAB8AQAAmQMAADAwAAABACAAFwIAABUFAACJUE5HDQoaCgAAAA1JSERSAAAAEAAAABAIBgAAAB/z/2EAAAAJcEhZcwAACxMAAAsTAQCanBgAAAChSURBVDjLY2CgBfj//38vED8H4hdQDGL3EqORD4hbgPjff0wAEmsGqcFnwAog3gXFr9EwSGw3EC/HZ8BTIDbCI28EUoPPAJB/9fHI64PUEDQAiJWA2AUNK5FiQBMQn0HDTUQbQA0vlEBDHIR3ALEiqQYYAHEoFIcAMRdJBlDihXtAbItH3g6I7+IzoBbqit048EsgriKUHyyQ/I+OzamecwGSNGtVmicKpwAAAABJRU5ErkJggolQTkcNChoKAAAADUlIRFIAAAAUAAAAFAgGAAAAjYkdDQAAAAlwSFlzAAALEwAACxMBAJqcGAAAAM1JREFUOMtjYKAX+P//vxgQ1wDxTDQMEhMjx8ANQPwbiP+gYZDYBlIMMgfiq/8JgytAbEbIMEYgfgTEe4C4FIhPAvF9NAwSKwHivUD8EKQHn4FyUNsdiPCJA1StLD5FylBF1kQYaA1VqzwwBkLZ07Akm2lQOZINNAXiE0B8Bg2fgMoNvJeFgDgFiNOQsDIlBroB8VsgfoeECwZPLFPLQGmoImciDHSGqpUmpPA6NHlkoUUIMgbJnQXia8SUNhrQjP8GLUKQ8RuoGg2GIQcA7s85OWltDOwAAAAASUVORK5CYIKJUE5HDQoaCgAAAA1JSERSAAAAGAAAABgIBgAAAOB3PfgAAAAJcEhZcwAACxMAAAsTAQCanBgAAADrSURBVEjHY2AYaPD//395IA4E4lA0DBKTo9RweyD++R83AMnZkWu4PhAf/k8YgNTok2p4FRD/+088+AvEFcQargTEf6AuAwXRLCA+DsQn0TBIbCYQO0DVgvQoEmNBKNRVPiT42BeqJ5QYxbFQxa4kWOAK1RM7wiwAYnYgPg/E73Dgs1A1ZFvADMQLgXg3DrwQqmYQxwGQ5gRiQTTMRq04ABn+EUvOPU1NHxQAcQcajhjZ+SAcqtiLBAu8oHrCiVGsAS2qt4JKRywpCB2D1GyD6lEj1kW9/0kHPaRWOs5AXI8lBaFjkBonhmELAGRBEafuvPbRAAAAAElFTkSuQmCCiVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAACXBIWXMAAAsTAAALEwEAmpwYAAABLklEQVRYw2NgGAVEgv///wsCcTcQ7wTi3TgwSK4LiAVo4YDD/4kHh6hpMSMQ2/4nHdiA9FJquRkQ3/hPPrgOxKbkWi4HxB+gBv0F4l8kWPwLqgcE3gOxDDkOmAg14AoQSwIxGxDnAvESIF6FAy+BqgGplYLqBYF+ShJdFgVRmAU14zA5mi9ANcdS4IBYqBkXRh0w9B0ApHmBuBaIOwhgkBpeWjggjYRyII0WDhAF4hl4ygAYBqkRHU2EtIgCdiDOAOJyLDgXlvBo6YBkAgmvitYOkAXitThaQpuAWHO0JBx2DjgH1RxHgQPioWacI0fzSqjm6RQ4YCbUjBXkaA6Hav4HxEtx5H98eClULwiEkuuDWf8pBzMobZr7APE0IN6Fp0eEjndB9XiP9ikHPQAAhn+uMfO0kxsAAAAASUVORK5CYIKJUE5HDQoaCgAAAA1JSERSAAAAMAAAADAIBgAAAFcC+YcAAAAJcEhZcwAACxMAAAsTAQCanBgAAAHJSURBVGje7Zk9SwNBEIZPTWGKELWzSKHGykL8wEr/hP4AUypiESwsxI9KgkmZJmIQtNJCC7XIHxD8QBFBS9FKRSttFOL6DkQY0mQvt3t7wgw8cHfJvjNv2F1mL54nIeE2lFJJMAOKoKRJsTYm6br4AfCkmo9H0nBVfAu4VsHjirRcGOhT5qI3zMLHQBk8GDRAWltg1PaU2QA/yl6Qds7KlILomgovVmzM92+W4BWsgllwH6DQu5oGab2x51+gx6SBZSb+AdLss1YwDubBoib03Qkay3T6wSfLs2TSwD4T3rG4znZZnj2TwhUmXLBooMDyVGwZyFs0kBcDYkAMiAF/BnCfBRfg0ic0JuvUAK5TAZs7GptyaSAB3gMYoLEJ11MoDRZ89EF/zPGeShaxGPjH22gbGAQjDeiOnAFcx8CZj10nGzUDaZ/b5mnUDNBx8kSzeDrnZiK5iPGsA3Q2IC67kBgQA2KgaeFDJlyyaGCT5TkwKZxjws+0LVoovgu8sDzrJsWH605eN2BSo//RZQrc1p3Uhkz/Qtshvl4v25ifcXAcQvFHoN3WIqPeJwPOQdVg0dVaVzvNX7l7lv8ri2n0P7rEPAkJiabiF0EmFEy75gxWAAAAAElFTkSuQmCC'
const ICO_BLACK_B64 =
  'AAABAAUAEBAAAAEAIADqAAAAVgAAABQUAAABACAAGAEAAEABAAAYGAAAAQAgADYBAABYAgAAICAAAAEAIAB9AQAAjgMAADAwAAABACAADQIAAAsFAACJUE5HDQoaCgAAAA1JSERSAAAAEAAAABAIBgAAAB/z/2EAAAAJcEhZcwAACxMAAAsTAQCanBgAAACcSURBVDjLY2CgEegF4udA/AKKn0PFCAI+IG4B4n9A/B8Ng8SaoWpwghVAvAuKX6NhkNhuIF6Oz4CnQGyER94IqgYnAPlXH4+8PlQNQQOUgNgFDSuRYkATEJ9Bw02kGECxF0qgIQ7CO4BYkVQDDIA4FIpDgJiLVAPI9sI9ILbFI28HxHfxGVALtWE3DvwSiKsI5QcLJP+jY3OqZ1sA6Yw6eI771l0AAAAASUVORK5CYIKJUE5HDQoaCgAAAA1JSERSAAAAFAAAABQIBgAAAI2JHQ0AAAAJcEhZcwAACxMAAAsTAQCanBgAAADKSURBVDjLY2CgIxAD4hognomGa6ByJIMNQPwbiP+g4d9QOaKBORBfBeL/BPAVIDYjZBgjED8C4j1AXArEJ4H4PhoGiZUA8V4gfgjVgxPIQW13IMInDlC1svgUKUMVWRNhoDVUrfKAGQhiT8OSbKZB5Ug20BSITwDxGTR8Aio38F4WAuIUIE5DwsqUGOgGxG+B+B0SLhhUsUwVA6WhipyJMNAZqlaakMLr0OSRhRYhyBgkdxaIrxFT2mhAM/4btAhBxm+gajQYhhwAAEp9WvsVggmqAAAAAElFTkSuQmCCiVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAACXBIWXMAAAsTAAALEwEAmpwYAAAA6ElEQVRIx2NgGARAHogDgTgUDYPE5Cg13B6IfwLxfxwYJGdHruH6QHwYj+EwfBiqliRQBcT/iDAchv8CcQWxhisB8R+oy0BBNAuIjwPxSTQMEpsJxA5QtSA9isRYEAp1lQ8JPvaF6gklRnEsVLErCRa4QvXEjjwL2IH4PBC/w4HPQtWQbQEzEC8E4t048EKomsEdB5xALIiG2ahlAcjwj1hy7mlq+qAAiDvQcMTIzgfhUMVeJFjgBdUTToxiDWhRvRVaOgoSwCA126B61Ih1US8JdQEM95Ba6TgDcT2WFISOQWqcGIYtAADoyoMLsEx+BgAAAABJRU5ErkJggolQTkcNChoKAAAADUlIRFIAAAAgAAAAIAgGAAAAc3p69AAAAAlwSFlzAAALEwAACxMBAJqcGAAAAS9JREFUWMNjYBgFxANBIO4G4p1AvBsHBsl1AbEALRxwGIj/E4kPUdNiRiC2JcFyGLaB6qUImAHxDTIsh+HrQGxKruVyQPwBatBfIP5FgsW/oHpA7PdALEOOAyZCDbgCxJJAzAbEuUC8BIhX4cBLoGpAaqWgekFm9FOS6LIoiMIsqBmHydF8Aao5lgIHxELNuDDqgGHhAF4grgXiDgK4FqqW6g5II6EcSKOFA0SBeAaeMgCGZ0DVjiZCqjuAHYgzgLgcC85FSng0c0AygYRXRWsHyALxWhwtoU1ArDlaEg47B5yDao6jwAHxUDPOkaN5JVTzdAocMBNqxgpyNIdDNf8D4qU48j8+vBSqF2RGKLk+mEVBixiGZ1DaNPcB4mlAvAtPjwgd74Lq8R7tUA56AADzYei+gqFdQgAAAABJRU5ErkJggolQTkcNChoKAAAADUlIRFIAAAAwAAAAMAgGAAAAVwL5hwAAAAlwSFlzAAALEwAACxMBAJqcGAAAAb9JREFUaN7tmD8vBEEYxtfZgkIOnUKBUynEn6j4EnwASiKKi0Ih/lRycVdec+IioaKgQHFfQMIJEQmlUCGuoiG545lkNnkzzc3uzuyu5H2SX3N788z7XGbm3lnHYbFiVxrMgyIoaVKUY9JxFz8EXsBvQJ6lRyxqAbchive4kV6Ra8BA8R79URY+AcrgyWAA4bULxm0vmW3QMFi4ivDO2VpSmxYLV1m3sd5/yATvYAMsgMcQhT5ID+H1QT7/Bn0mA6wR80+QIc9SYBIsgRVNxHen5FhPg+CLzLNqMsARMd63uM8OyDyHJo0rxLhgMUCBzFOxFSBvMUCeA3AADsABfAfIgiq49klVjo01QG/I5q4hPWIL0AFqIQLUpEesS0j0Rcs++iCPRaWn4k3MAf5rgFYwDMaa0JPEAC649HHqZJMWIOPz2LxIWgBxJTzXLF7cc+eSuok7QVcT2vkU4gAcgAME1gkxLlkMsEPmOTZpnCPGr/JYNK1u8Ebm2TJpPqrcvO7AtEb/o8sMuFduaiOmf6G9CF+vl22sT/FPehZB8aegzdYmS8l+5grUDRZdl13trPLK3apcjf5HF9dhsViB9AeFqAvkTFtw2QAAAABJRU5ErkJggg=='

/**
 * Which taskbar we are drawing on — NOT which theme the user's apps use.
 *
 * nativeTheme.shouldUseDarkColors maps to AppsUseLightTheme, and "dark apps with a
 * light taskbar" is a common Windows configuration. Following it there paints a
 * white glyph onto a white taskbar: present, clickable and invisible, which is
 * exactly the black-on-black failure this file already documents for GNOME.
 * SystemUsesLightTheme is the taskbar's own setting and the only correct source.
 *
 * reg.exe is used rather than a dependency because this is one value read at most a
 * handful of times per session. windowsHide keeps a console window from flashing.
 */
function windowsTaskbarIsLight(): boolean {
  try {
    const out = execFileSync(
      'reg.exe',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize', '/v', 'SystemUsesLightTheme'],
      { encoding: 'utf8', timeout: 2000, windowsHide: true }
    )
    // "    SystemUsesLightTheme    REG_DWORD    0x1"
    return /0x1\s*$/m.test(out.trim())
  } catch {
    // The value is absent on some Server SKUs and on a fresh profile before the
    // user has touched personalisation. Windows' own default there is a DARK
    // taskbar, so a white glyph is the safer guess.
    return false
  }
}

/**
 * Decode the glyph. Tagged scaleFactor 2 so the 44x44 bitmap reads as a 22pt icon and
 * stays crisp on Retina.
 */
function trayIcon(): Electron.NativeImage {
  if (WIN32) {
    // Multi-frame .ico, and the colour chosen from the TASKBAR's theme. Windows has
    // no template-image concept, so like Linux the glyph itself must be the right
    // colour — but unlike Linux the taskbar is not dark in every theme.
    const b64 = windowsTaskbarIsLight() ? ICO_BLACK_B64 : ICO_WHITE_B64
    return nativeImage.createFromBuffer(Buffer.from(b64, 'base64'))
  }
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
    MACOS ? { accelerator: mac } : {}
  // The one reliable correction path for dictations we can't observe (terminals like
  // WezTerm, or any app we didn't paste into via our own field): reopen the last
  // transcript here, fix the word, and the scratchpad-edit path learns the rule.
  const canCorrect = settings.dictation.learnCorrections === true
  const menu = Menu.buildFromTemplate([
    { label: 'Open clipboard palette', ...acc('Cmd+Shift+V'), click: () => showPalette() },
    ...(canCorrect
      ? [
          {
            label: 'Correct last dictation',
            click: (): void => {
              const id = lastDictationId()
              if (id !== undefined) openScratchpadWindow(id)
            }
          }
        ]
      : []),
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
  // macOS ONLY. setTitle is a documented no-op on Windows and Linux, so the unread
  // badge — the only signal a blocked agent waiting on the user has — simply
  // vanished there. Elsewhere the count rides in the tooltip above and in the menu
  // item's own label, both of which are already built.
  if (MACOS) tray.setTitle(unread > 0 ? String(unread) : '')
}

export function createTray(): void {
  if (tray) return
  try {
    const icon = trayIcon()
    if (icon.isEmpty()) throw new Error('tray icon failed to decode')
    tray = new Tray(icon)
    buildTrayMenu()
    // Log the success too. The previous version logged only failures, so when the
    // icon silently never appeared there was nothing to distinguish "created fine"
    // from "never got there" — which is exactly what happened.
    console.log('[tray] menu bar icon created')
    if (WIN32) {
      // setContextMenu binds the RIGHT button only on Windows, so without this the
      // left click — the one everybody tries first — does nothing at all, on the
      // app's only discovery surface for a process with no window and no Dock icon.
      tray.on('click', () => showPalette())
      // The taskbar theme can change while we are running, and the icon does not
      // repaint itself. nativeTheme fires for the apps setting, which is a good
      // enough trigger to re-read the taskbar one.
      nativeTheme.on('updated', () => {
        try {
          tray?.setImage(trayIcon())
        } catch (err) {
          console.error('[tray] could not refresh the icon for the new theme:', err)
        }
      })
    }
    // No click handler on macOS or Linux. setContextMenu already opens the menu on
    // left click there; adding one on top summoned the palette AND the menu
    // together, overlapping each other. Windows is the opposite case — see above.
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
