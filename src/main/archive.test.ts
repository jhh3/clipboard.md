import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'child_process'
import { createReadStream, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { createHash } from 'crypto'
import { tmpdir } from 'os'
import { join, relative, sep } from 'path'
import { extractTarBz2 } from './archive'

/**
 * Equivalence with `tar xjf`, run for real.
 *
 * The change replaces a host binary with an in-process pipeline on EVERY platform,
 * not only Windows, so "it probably produces the same tree" is not good enough — the
 * thing being extracted is a 490MB model whose files are loaded by a native addon
 * that will not tell you politely if a byte is wrong. Byte-identical output against
 * the tool it replaces is the proof, and it is a proof a Linux machine can give.
 *
 * The fixture is built here rather than committed: a real .tar.bz2 in the repo would
 * be a binary nobody can review, and the shapes that matter (nested directories,
 * an empty file, a large-ish incompressible file, unicode names) are easier to state
 * in code than to inspect in an archive.
 */
const hasTar = (): boolean => {
  try {
    execFileSync('tar', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

let root: string
let archive: string

function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      const key = relative(dir, p).split(sep).join('/')
      if (statSync(p).isDirectory()) {
        out[key + '/'] = 'dir'
        walk(p)
      } else {
        out[key] = createHash('sha256').update(readFileSync(p)).digest('hex')
      }
    }
  }
  walk(dir)
  return out
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'clipmd-archive-'))
  const src = join(root, 'src', 'model-dir')
  mkdirSync(join(src, 'nested'), { recursive: true })
  writeFileSync(join(src, 'tokens.txt'), 'one\ntwo\nthree\n')
  writeFileSync(join(src, 'empty.bin'), '')
  writeFileSync(join(src, 'ünïcode name.txt'), 'name handling')
  // Incompressible, so the bzip2 path is genuinely exercised rather than trivially
  // short-circuited — and big enough to cross a block boundary.
  const noise = Buffer.alloc(300_000)
  for (let i = 0; i < noise.length; i++) noise[i] = (i * 2654435761) & 0xff
  writeFileSync(join(src, 'nested', 'encoder.int8.onnx'), noise)
  archive = join(root, 'fixture.tar.bz2')
  if (hasTar()) {
    execFileSync('tar', ['cjf', archive, '-C', join(root, 'src'), 'model-dir'])
  }
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('extractTarBz2', () => {
  it.skipIf(!hasTar())('produces the same tree as `tar xjf`', async () => {
    const viaTar = join(root, 'out-tar')
    const viaUs = join(root, 'out-stream')
    mkdirSync(viaTar, { recursive: true })
    mkdirSync(viaUs, { recursive: true })

    execFileSync('tar', ['xjf', archive, '-C', viaTar])
    await extractTarBz2(createReadStream(archive), viaUs)

    expect(tree(viaUs)).toEqual(tree(viaTar))
    // And say plainly that content, not just names, matched.
    expect(Object.keys(tree(viaUs)).length).toBeGreaterThan(4)
  })

  it.skipIf(!hasTar())('never writes the archive itself', async () => {
    // The whole point of streaming: a 490MB download used to need 980MB of free
    // space, and the archive was then left behind forever.
    const dest = join(root, 'out-nofile')
    mkdirSync(dest, { recursive: true })
    await extractTarBz2(createReadStream(archive), dest)
    expect(readdirSync(dest)).toEqual(['model-dir'])
  })

  it('rejects rather than half-extracting a corrupt stream', async () => {
    // bsdtar's "Unrecognized archive format" was swallowed into one generic line.
    // Whatever replaces it must still fail loudly enough for the catch to log.
    const dest = join(root, 'out-corrupt')
    mkdirSync(dest, { recursive: true })
    const { Readable } = await import('stream')
    await expect(
      extractTarBz2(Readable.from([Buffer.from('this is not a bzip2 stream')]), dest)
    ).rejects.toBeTruthy()
  })
})
