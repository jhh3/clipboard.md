/**
 * The one place `process.platform` is read.
 *
 * Every platform decision in this app used to be spelled either
 * `=== 'darwin'` or `!== 'linux'`, and the two idioms disagree about Windows: the
 * first sends it down the Linux path, the second down the macOS one. Neither is a
 * decision anyone made. The result was a Windows build that spawned `xprop` and
 * `gsettings`, wrote an XDG `.desktop` file into `%USERPROFILE%\.config`, and then
 * reported success for all of it.
 *
 * So the rule is: no module outside this one reads `process.platform`. A
 * `platform-idioms.test.ts` grep enforces it, because the `!== 'linux'` idiom is
 * easy to re-introduce and impossible to spot in review — it does not mention
 * Windows anywhere.
 *
 * Prefer the pure `*For(platform)` helpers in the modules that have them: a decision
 * expressed as a function of a platform argument can be tested for all three from
 * Linux, which is the only way we can prove the Linux and macOS behaviour did not
 * move while Windows support was added.
 */

export type Platform = 'darwin' | 'linux' | 'win32' | 'other'

/** Narrow `process.platform` (a NodeJS.Platform, 12 values) to the four we branch on. */
export function asPlatform(p: string): Platform {
  return p === 'darwin' || p === 'linux' || p === 'win32' ? p : 'other'
}

export function currentPlatform(): Platform {
  return asPlatform(process.platform)
}

export const MACOS = currentPlatform() === 'darwin'
export const LINUX = currentPlatform() === 'linux'
export const WIN32 = currentPlatform() === 'win32'
