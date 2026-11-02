#!/usr/bin/env node
/**
 * Assert the things about a packaged build that only a packaged build can be wrong
 * about.
 *
 * Every check here is a bug this project has actually shipped:
 *
 *  - a platform `files:` list containing nothing but negations makes electron-builder
 *    fall back to `**\/*`, silently discarding the top-level allowlist — the asar
 *    then held 104 `src/` entries and the whole working tree;
 *  - sqlite-vec and sherpa-onnx load native libraries by path, which does not exist
 *    inside app.asar, so semantic search and local transcription were dead in the
 *    installed build while dev worked perfectly.
 *
 *   node scripts/verify-package.mjs dist/linux-unpacked
 */
import { existsSync, readdirSync, openSync, readSync, closeSync, statSync } from 'fs'
import { join, sep } from 'path'

const root = process.argv[2]
if (!root) {
  console.error('usage: verify-package.mjs <unpacked-app-dir>')
  process.exit(2)
}

const failures = []
const notes = []
/** `label` names the invariant; `whenBroken` says what breaks in the shipped app. */
const check = (ok, label, whenBroken) =>
  ok ? notes.push(`ok    ${label}`) : failures.push(`${label} — ${whenBroken}`)

/**
 * List the paths inside an asar without depending on @electron/asar.
 *
 * The format is a Chromium Pickle: uint32 header-size field, then a pickle whose
 * payload is a uint32 length followed by that many bytes of JSON. Reading it here
 * rather than importing a transitive dependency of electron-builder means this
 * script keeps working when that dependency tree changes — and it is 20 lines.
 */
function asarEntries(file) {
  const fd = openSync(file, 'r')
  try {
    const head = Buffer.alloc(16)
    readSync(fd, head, 0, 16, 0)
    const jsonSize = head.readUInt32LE(12)
    const json = Buffer.alloc(jsonSize)
    readSync(fd, json, 0, jsonSize, 16)
    const tree = JSON.parse(json.toString('utf8'))
    const out = []
    const walk = (node, prefix) => {
      for (const [name, child] of Object.entries(node.files ?? {})) {
        const p = prefix ? `${prefix}/${name}` : name
        if (child.files) walk(child, p)
        else out.push(p)
      }
    }
    walk(tree, '')
    return out
  } finally {
    closeSync(fd)
  }
}

function walkDir(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walkDir(p, out)
    else out.push(p)
  }
  return out
}

// The resources directory sits beside the executable on Linux and inside
// Contents/ on macOS.
const resources = [join(root, 'resources'), join(root, 'Contents', 'Resources')].find((p) =>
  existsSync(join(p, 'app.asar'))
)
if (!resources) {
  console.error(`no app.asar found under ${root}`)
  process.exit(2)
}

const platform = existsSync(join(root, 'Contents')) ? 'mac' : 'linux'
const dyn = { mac: '.dylib', linux: '.so' }[platform]

// (a) No source in the shipped asar. This is the negation-only `files:` trap.
const entries = asarEntries(join(resources, 'app.asar'))
const srcEntries = entries.filter((p) => p === 'src' || p.startsWith('src/'))
check(
  srcEntries.length === 0,
  'app.asar ships no src/',
  `it holds ${srcEntries.length} source entries (first: ${srcEntries[0]}) — the platform files: list is negation-only, so electron-builder fell back to **/*`
)
check(entries.length > 0, 'app.asar is non-empty', 'it contains no files at all')

// (b) Payloads nothing executes at runtime: the browser onnxruntime build (Node
// embeddings use onnxruntime-node) and the musl duplicates of glibc native libs.
const deadWeight = entries.filter((p) => /node_modules\/onnxruntime-web\//.test(p))
check(
  deadWeight.length === 0,
  'app.asar ships no onnxruntime-web',
  `${deadWeight.length} onnxruntime-web entries (~134MB) shipped although embeddings run on onnxruntime-node`
)

const unpacked = join(resources, 'app.asar.unpacked')
const unpackedFiles = walkDir(unpacked)
const base = (p) => p.split(sep).pop()

// (c) sherpa-onnx's addon must be unpacked AND find its runtime beside it: the addon
// dlopens by path, and a path inside app.asar does not exist.
const addon = unpackedFiles.find((p) => base(p) === 'sherpa-onnx.node')
check(
  !!addon,
  'sherpa-onnx.node is unpacked',
  'it is inside app.asar, which is a file — the addon cannot be dlopened and local transcription dies at load'
)
if (addon) {
  const dir = addon.slice(0, addon.length - base(addon).length)
  const siblings = unpackedFiles.filter((p) => p.startsWith(dir)).map(base)
  const runtime = siblings.some((n) => n.startsWith('onnxruntime') || n.startsWith('libonnxruntime'))
  check(
    runtime,
    'sherpa-onnx.node has its onnxruntime library as a sibling',
    `nothing named onnxruntime* sits in ${dir}, so the addon loads and then fails to resolve its own runtime`
  )
}

// (d) sqlite-vec, which is how semantic search silently died once already.
check(
  unpackedFiles.some((p) => base(p) === `vec0${dyn}`),
  `vec0${dyn} is unpacked`,
  'sqlite cannot load the extension from inside app.asar, and semantic search is disabled with no error'
)

// (e) No musl variants: this build runs on glibc (or macOS), so they never load.
const musl = unpackedFiles.filter((p) => /musl/.test(p))
check(musl.length === 0, 'no musl native libraries', `${musl.length} musl files shipped, e.g. ${musl[0]}`)

// (f) Only this platform's onnxruntime binding. Each foreign one is ~110MB, and the
// exclusion that prunes them is the same list that once deleted the binding macOS
// needed — so assert what SHOULD be here as well as what should not.
const nativeDir = { mac: 'darwin', linux: 'linux' }[platform]
const bindingRoot = join(unpacked, 'node_modules', 'onnxruntime-node', 'bin', 'napi-v6')
if (existsSync(bindingRoot)) {
  const shipped = readdirSync(bindingRoot)
  const foreign = shipped.filter((p) => p !== nativeDir)
  check(
    foreign.length === 0,
    'only this platform\'s onnxruntime binding',
    `${foreign.join(', ')} also shipped, ~110MB each`
  )
  check(
    shipped.includes(nativeDir),
    `the ${nativeDir} onnxruntime binding survived pruning`,
    'the exclusion list deleted the binding this build needs — embeddings would store nothing while dev worked fine'
  )
}

for (const n of notes) console.log(n)
for (const f of failures) console.error(`FAIL  ${f}`)
console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'} — ${notes.length} ok, ${failures.length} failed (${platform} build at ${root})`)
process.exit(failures.length === 0 ? 0 : 1)
