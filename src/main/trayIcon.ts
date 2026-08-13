
/**
 * The Windows tray glyph, one PNG per notification-area size.
 *
 * NOT an .ico, and that is the whole point. This shipped as two multi-frame .ico
 * blobs fed to `nativeImage.createFromBuffer`, which has no ICO decoder: it tries
 * PNG, then JPEG, then a raw-pixel fallback that needs an explicit width/height it
 * was never given. Every Windows build therefore got an empty image (verified
 * against the Electron 43.2.0 we ship: isEmpty() === true, size 0x0), `createTray`
 * threw, the catch logged, and the app ran with no tray icon — on a process with no
 * window and no Dock icon, i.e. no way to reach it at all. ICO is decoded only by
 * `createFromPath`, only on Windows, and so cannot be proven anywhere but Windows.
 *
 * The reason the .ico existed is kept: Windows asks the notification area for 16px
 * at 100% scaling and 20/24/32/48px as the display scales up, and downscaling one
 * larger bitmap with a generic filter turns 1.5px strokes into grey mush. So each
 * size is still rendered AT that size — just handed over as separate PNG
 * representations, which nativeImage decodes on every platform and a test can check.
 *
 * Two colours because Windows has no template-image concept: see windowsTaskbarIsLight
 * in tray.ts for why the TASKBAR's theme, not the apps' theme, chooses between them.
 *
 * Regenerate with scripts/make-tray-png.mjs (system node, not Electron — sharp's
 * librsvg loader segfaults inside the Electron process; see the note in tray.ts).
 */
const TRAY_PNG_WHITE: Record<number, string> = {
  16:
    'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAACXBIWXMAAAsTAAALEwEAmpwYAAAAoUlEQVQ4y2NgoAX4//9/LxA/B+IXUAxi9xKjkQ+IW4D4339MABJrBqnBZ8AKIN4Fxa/RMEhsNxAvx2fAUyA2wiNvBFKDzwCQf/XxyOuD1BA0AIiVgNgFDSuRYkATEJ9Bw01EG0ANL5RAQxyEdwCxIqkGGABxKBSHADEXSQZQ4oV7QGyLR94OiO/iM6AW6ordOPBLIK4ilB8skPyPjs2pnnMBkjRrVZonCqcAAAAASUVORK5CYII=',
  20:
    'iVBORw0KGgoAAAANSUhEUgAAABQAAAAUCAYAAACNiR0NAAAACXBIWXMAAAsTAAALEwEAmpwYAAAAzUlEQVQ4y2NgoBf4//+/GBDXAPFMNAwSEyPHwA1A/BuI/6BhkNgGUgwyB+Kr/wmDK0BsRsgwRiB+BMR7gLgUiE8C8X00DBIrAeK9QPwQpAefgXJQ2x2I8IkDVK0sPkXKUEXWRBhoDVWrPDAGQtnTsCSbaVA5kg00BeITQHwGDZ+Ayg28l4WAOAWI05CwMiUGugHxWyB+h4QLBk8sU8tAaagiZyIMdIaqlSak8Do0eWShRQgyBsmdBeJrxJQ2GtCM/wYtQpDxG6gaDYYhBwDuzzk5aW0M7AAAAABJRU5ErkJggg==',
  24:
    'iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAACXBIWXMAAAsTAAALEwEAmpwYAAAA60lEQVRIx2NgGGjw//9/eSAOBOJQNAwSk6PUcHsg/vkfNwDJ2ZFruD4QH/5PGIDU6JNqeBUQ//tPPPgLxBXEGq4ExH+gLgMF0SwgPg7EJ9EwSGwmEDtA1YL0KBJjQSjUVT4k+NgXqieUGMWxUMWuJFjgCtUTO8IsAGJ2ID4PxO9w4LNQNWRbwAzEC4F4Nw68EKpmEMcBkOYEYkE0zEatOAAZ/hFLzj1NTR8UAHEHGo4Y2fkgHKrYiwQLvKB6wolRrAEtqreCSkcsKQgdg9Rsg+pRI9ZFvf9JBz2kVjrOQFyPJQWhY5AaJ4ZhCwBkQRGn7rz20QAAAABJRU5ErkJggg==',
  32:
    'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAACXBIWXMAAAsTAAALEwEAmpwYAAABLklEQVRYw2NgGAVEgv///wsCcTcQ7wTi3TgwSK4LiAVo4YDD/4kHh6hpMSMQ2/4nHdiA9FJquRkQ3/hPPrgOxKbkWi4HxB+gBv0F4l8kWPwLqgcE3gOxDDkOmAg14AoQSwIxGxDnAvESIF6FAy+BqgGplYLqBYF+ShJdFgVRmAU14zA5mi9ANcdS4IBYqBkXRh0w9B0ApHmBuBaIOwhgkBpeWjggjYRyII0WDhAF4hl4ygAYBqkRHU2EtIgCdiDOAOJyLDgXlvBo6YBkAgmvitYOkAXitThaQpuAWHO0JBx2DjgH1RxHgQPioWacI0fzSqjm6RQ4YCbUjBXkaA6Hav4HxEtx5H98eClULwiEkuuDWf8pBzMobZr7APE0IN6Fp0eEjndB9XiP9ikHPQAAhn+uMfO0kxsAAAAASUVORK5CYII=',
  48:
    'iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAACXBIWXMAAAsTAAALEwEAmpwYAAAByUlEQVRo3u2ZPUsDQRCGT01hihC1s0ihxspC/MBK/4T+AFMqYhEsLMSPSoJJmSZiELTSQgu1yB8Q/EARQUvRSkUrbRTi+g5EGNJkL7d7e8IMPHB3yb4zb9hdZi+eJyHhNpRSSTADiqCkSbE2Jum6+AHwpJqPR9JwVXwLuFbB44q0XBjoU+aiN8zCx0AZPBg0QFpbYNT2lNkAP8pekHbOypSC6JoKL1ZszPdvluAVrIJZcB+g0LuaBmm9sedfoMekgWUm/gHS7LNWMA7mwaIm9N0JGst0+sEny7Nk0sA+E96xuM52WZ49k8IVJlywaKDA8lRsGchbNJAXA2JADIgBfwZwnwUX4NInNCbr1ACuUwGbOxqbcmkgAd4DGKCxCddTKA0WfPRBf8zxnkoWsRj4x9toGxgEIw3ojpwBXMfAmY9dJxs1A2mf2+Zp1AzQcfJEs3g652YiuYjxrAN0NiAuu5AYEANioGnhQyZcsmhgk+U5MCmcY8LPtC1aKL4LvLA86ybFh+tOXjdgUqP/0WUK3Nad1IZM/0LbIb5eL9uYn3FwHELxR6Dd1iKj3icDzkHVYNHVWlc7zV+5e5b/K4tp9D+6xDwJCYmm4hdBJhRMu+YMVgAAAABJRU5ErkJggg==',
}
const TRAY_PNG_BLACK: Record<number, string> = {
  16:
    'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAACXBIWXMAAAsTAAALEwEAmpwYAAAAnElEQVQ4y2NgoBHoBeLnQPwCip9DxQgCPiBuAeJ/QPwfDYPEmqFqcIIVQLwLil+jYZDYbiBejs+Ap0BshEfeCKoGJwD5Vx+PvD5UDUEDlIDYBQ0rkWJAExCfQcNNpBhAsRdKoCEOwjuAWJFUAwyAOBSKQ4CYi1QDyPbCPSC2xSNvB8R38RlQC7VhNw78EoirCOUHCyT/o2NzqmdbAOmMOniO+9ZdAAAAAElFTkSuQmCC',
  20:
    'iVBORw0KGgoAAAANSUhEUgAAABQAAAAUCAYAAACNiR0NAAAACXBIWXMAAAsTAAALEwEAmpwYAAAAyklEQVQ4y2NgoCMQA+IaIJ6JhmugciSDDUD8G4j/oOHfUDmigTkQXwXi/wTwFSA2I2QYIxA/AuI9QFwKxCeB+D4aBomVAPFeIH4I1YMTyEFtdyDCJw5QtbL4FClDFVkTYaA1VK3ygBkIYk/DkmymQeVINtAUiE8A8Rk0fAIqN/BeFgLiFCBOQ8LKlBjoBsRvgfgdEi4YVLFMFQOloYqciTDQGapWmpDC69DkkYUWIcgYJHcWiK8RU9poQDP+G7QIQcZvoGo0GIYcAABKfVr7FYIJqgAAAABJRU5ErkJggg==',
  24:
    'iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAACXBIWXMAAAsTAAALEwEAmpwYAAAA6ElEQVRIx2NgGARAHogDgTgUDYPE5Cg13B6IfwLxfxwYJGdHruH6QHwYj+EwfBiqliRQBcT/iDAchv8CcQWxhisB8R+oy0BBNAuIjwPxSTQMEpsJxA5QtSA9isRYEAp1lQ8JPvaF6gklRnEsVLErCRa4QvXEjjwL2IH4PBC/w4HPQtWQbQEzEC8E4t048EKomsEdB5xALIiG2ahlAcjwj1hy7mlq+qAAiDvQcMTIzgfhUMVeJFjgBdUTToxiDWhRvRVaOgoSwCA126B61Ih1US8JdQEM95Ba6TgDcT2WFISOQWqcGIYtAADoyoMLsEx+BgAAAABJRU5ErkJggg==',
  32:
    'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAACXBIWXMAAAsTAAALEwEAmpwYAAABL0lEQVRYw2NgGAXEA0Eg7gbinUC8GwcGyXUBsQAtHHAYiP8TiQ9R02JGILYlwXIYtoHqpQiYAfENMiyH4etAbEqu5XJA/AFq0F8g/kWCxb+gekDs90AsQ44DJkINuALEkkDMBsS5QLwEiFfhwEugakBqpaB6QWb0U5LosiiIwiyoGYfJ0XwBqjmWAgfEQs24MOqAYeEAXiCuBeIOArgWqpbqDkgjoRxIo4UDRIF4Bp4yAIZnQNWOJkKqO4AdiDOAuBwLzkVKeDRzQDKBhFdFawfIAvFaHC2hTUCsOVoSDjsHnINqjqPAAfFQM86Ro3klVPN0ChwwE2rGCnI0h0M1/wPipTjyPz68FKoXZEYouT6YRUGLGIZnUNo09wHiaUC8C0+PCB3vgurxHu1QDnoAAPNh6L6CoV1CAAAAAElFTkSuQmCC',
  48:
    'iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAACXBIWXMAAAsTAAALEwEAmpwYAAABv0lEQVRo3u2YPy8EQRjG19mCQg6dQoFTKcSfqPgSfABKIoqLQiH+VHJxV15z4iKhoqBAcV9AwgkRCaVQIa6iIbnjmWQ2eTPNze7O7K7kfZJfc3vzzPtcZubeWcdhsWJXGsyDIihpUpRj0nEXPwRewG9AnqVHLGoBtyGK97iRXpFrwEDxHv1RFj4ByuDJYADhtQvGbS+ZbdAwWLiK8M7ZWlKbFgtXWbex3n/IBO9gAyyAxxCFPkgP4fVBPv8GfSYDrBHzT5Ahz1JgEiyBFU3Ed6fkWE+D4IvMs2oywBEx3re4zw7IPIcmjSvEuGAxQIHMU7EVIG8xQJ4DcAAOwAF8B8iCKrj2SVWOjTVAb8jmriE9YgvQAWohAtSkR6xLSPRFyz76II9FpafiTcwB/muAVjAMxprQk8QALrj0cepkkxYg4/PYvEhaAHElPNcsXtxz55K6iTtBVxPa+RTiAByAAwTWCTEuWQywQ+Y5NmmcI8av8lg0rW7wRubZMmk+qty87sC0Rv+jywy4V25qI6Z/ob0IX6+XbaxP8U96FkHxp6DN1iZLyX7mCtQNFl2XXe2s8srdqlyN/kcX12GxWIH0B4WoC+RMW3DZAAAAAElFTkSuQmCC',
}

/** The size Windows asks for at 100% scaling; every other frame is a multiple of it. */
export const TRAY_BASE_SIZE = 16

export interface TrayFrame {
  /** Pixel size of the bitmap, and `TRAY_BASE_SIZE * scaleFactor`. */
  size: number
  scaleFactor: number
  buffer: Buffer
}

/**
 * The frames to hand nativeImage, base representation first.
 *
 * Pure and separate from tray.ts so a test can assert the exact bytes and scale
 * factors the Windows build uses, and then push them through a real nativeImage —
 * the check that would have caught the .ico blobs decoding to nothing.
 */
export function windowsTrayFrames(taskbarIsLight: boolean): TrayFrame[] {
  const frames = taskbarIsLight ? TRAY_PNG_BLACK : TRAY_PNG_WHITE
  return Object.keys(frames)
    .map(Number)
    .sort((a, b) => a - b)
    .map((size) => ({
      size,
      // Electron picks a representation by scale factor, not by pixel size, so a
      // 32px bitmap has to be declared as 16pt @2x or it is drawn at the wrong size.
      scaleFactor: size / TRAY_BASE_SIZE,
      buffer: Buffer.from(frames[size], 'base64')
    }))
}
