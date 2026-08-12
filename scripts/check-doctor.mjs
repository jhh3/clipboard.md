#!/usr/bin/env node
/**
 * Diff a `--doctor` report's capability table against the committed contract.
 *
 * The point is not that the capabilities are good — it is that they are DECLARED.
 * Adding a Windows feature without saying so here fails the build, and so does
 * losing one, which is the only way "Windows v1 does not ship hold-to-talk" stays a
 * fact rather than a sentence in a commit message nobody re-reads.
 *
 *   node scripts/check-doctor.mjs doctor.json .github/expected-capabilities.win32.json
 */
import { readFileSync } from 'fs'

const [reportPath, expectedPath] = process.argv.slice(2)
if (!reportPath || !expectedPath) {
  console.error('usage: check-doctor.mjs <doctor.json> <expected.json>')
  process.exit(2)
}

const report = JSON.parse(readFileSync(reportPath, 'utf8'))
const expected = JSON.parse(readFileSync(expectedPath, 'utf8'))

// Only the states are compared. The reasons are user-facing prose and should be free
// to improve without a CI failure; a state change is the thing that means something.
const actual = Object.fromEntries(Object.entries(report.capabilities).map(([k, v]) => [k, v.state]))

const problems = []
for (const key of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
  if (expected[key] !== actual[key]) {
    problems.push(`${key}: expected ${expected[key] ?? '(absent)'}, got ${actual[key] ?? '(absent)'}`)
  }
}

if (problems.length > 0) {
  console.error('Capability contract mismatch:')
  for (const p of problems) console.error(`  ${p}`)
  console.error(`\nIf the change is intended, update ${expectedPath} in the same commit.`)
  process.exit(1)
}

console.log(`capabilities match ${expectedPath} (${Object.keys(actual).length} entries)`)
