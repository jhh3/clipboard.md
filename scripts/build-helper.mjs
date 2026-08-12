#!/usr/bin/env node
/**
 * Build the macOS side-car, on macOS only.
 *
 * `pnpm dev` used to run `bash src/native/mac/build.sh` unconditionally. On Windows
 * there is no bash on PATH in a normal shell, so the FIRST thing a Windows
 * contributor sees is the dev script failing before Electron is even reached — for a
 * helper that platform cannot use and does not need. Under Git Bash it is worse: bash
 * IS found, the script runs, `swiftc` is missing, and the failure is a Swift
 * toolchain error on a machine that will never have one.
 */
import { execFileSync } from 'child_process'

if (process.platform !== 'darwin') {
  console.log(`[helper] skipping the macOS helper build on ${process.platform}`)
  process.exit(0)
}

execFileSync('bash', ['src/native/mac/build.sh'], { stdio: 'inherit' })
