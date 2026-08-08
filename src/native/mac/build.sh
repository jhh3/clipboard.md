#!/usr/bin/env bash
# Build the macOS side-car helper as a universal binary into resources/mac/.
#
# Universal rather than host-arch: a dmg built on an Apple Silicon machine still has
# to run on Intel Macs, and there is no second build machine.
#
# swiftc takes ONE -target — passing two silently keeps the last and you get a
# single-arch binary that looks like it worked. So: compile each slice separately and
# lipo them together, then assert the result actually has both.
#
# macOS 12 baseline matches Electron 43's own minimum, so the helper never becomes
# the reason a Mac can't run the app.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../../.." && pwd)"
out="$root/resources/mac"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "[helper] not macOS — skipping (expected on the Linux build)"
  exit 0
fi

# Skip when already up to date, so wiring this into `pnpm dev` doesn't add ~15s of
# swiftc to every start. `--force` rebuilds regardless.
if [[ "${1:-}" != "--force" && -f "$out/clipmd-helper" && "$out/clipmd-helper" -nt "$here/clipmd-helper.swift" ]]; then
  echo "[helper] up to date ($(lipo -archs "$out/clipmd-helper"))"
  exit 0
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

for arch in arm64 x86_64; do
  echo "[helper] compiling $arch"
  swiftc \
    -target "${arch}-apple-macos12" \
    -O \
    -framework AppKit \
    -framework AVFoundation \
    -framework ApplicationServices \
    -framework CoreGraphics \
    -o "$tmp/clipmd-helper.$arch" \
    "$here/clipmd-helper.swift"
done

mkdir -p "$out"
lipo -create -output "$out/clipmd-helper" "$tmp/clipmd-helper.arm64" "$tmp/clipmd-helper.x86_64"
chmod +x "$out/clipmd-helper"

archs="$(lipo -archs "$out/clipmd-helper")"
for want in arm64 x86_64; do
  case " $archs " in
    *" $want "*) ;;
    *) echo "[helper] FATAL: $want missing from universal binary (got: $archs)" >&2; exit 1 ;;
  esac
done
echo "[helper] built $out/clipmd-helper ($archs)"
