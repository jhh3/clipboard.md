import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, sep } from 'path'
import { asPlatform, currentPlatform } from './platform'

/**
 * The idiom guard.
 *
 * `process.platform !== 'linux'` reads as "the other one" and silently means "macOS
 * OR Windows". Every Windows bug in the first survey of this codebase was one of
 * those: the Linux `.desktop` autostart writer, the `xprop` spawns, the
 * `clipboard.readText()` stand-in for the PRIMARY selection. None of them mention
 * Windows, so none of them are findable by searching for it, and none of them would
 * be caught in review.
 *
 * Failing the build on a bare `process.platform` read is the only thing that stops
 * the idiom coming back. platform.ts is where the read belongs; everything else takes
 * a `Platform` argument or imports a flag.
 */
const ROOTS = ['src/main', 'src/shared']

/**
 * src/preload/index.ts is deliberately NOT covered: it exists to hand the raw
 * platform string to the renderer, which is the one legitimate read outside here.
 */
const ALLOWED = new Set(['src/main/platform.ts', 'src/main/platform.test.ts'])

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    // Normalised to forward slashes: join() yields backslashes on Windows, so every
    // path missed the POSIX allowlist and the whole tree reported as violations.
    const p = join(dir, entry).split(sep).join('/')
    if (statSync(p).isDirectory()) walk(p, out)
    else if (p.endsWith('.ts') || p.endsWith('.tsx')) out.push(p)
  }
  return out
}

describe('platform idioms', () => {
  it('reads process.platform only in platform.ts', () => {
    const offenders: string[] = []
    for (const root of ROOTS) {
      for (const file of walk(root)) {
        if (ALLOWED.has(file)) continue
        const src = readFileSync(file, 'utf8')
        src.split('\n').forEach((line, i) => {
          // Comments may still discuss it — the hazard is a live read.
          const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '')
          if (code.includes('process.platform')) offenders.push(`${file}:${i + 1}`)
        })
      }
    }
    expect(offenders).toEqual([])
  })
})

describe('asPlatform', () => {
  it('keeps the three we branch on and collapses the rest', () => {
    expect(asPlatform('darwin')).toBe('darwin')
    expect(asPlatform('linux')).toBe('linux')
    expect(asPlatform('win32')).toBe('win32')
    expect(asPlatform('freebsd')).toBe('other')
    expect(asPlatform('aix')).toBe('other')
  })

  it('agrees with the running process', () => {
    expect(currentPlatform()).toBe(asPlatform(process.platform))
  })
})
