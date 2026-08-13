/**
 * Minimal declarations for the two extraction packages, which ship no types.
 *
 * Deliberately narrow: only the shapes transcribe.ts actually calls. A wider
 * hand-written declaration is a promise about someone else's API that nothing
 * checks, and it goes stale silently — the same failure this whole port is about.
 * (x11 is declared the same way in x11.d.ts, for the same reason.)
 */
declare module 'unbzip2-stream' {
  import type { Duplex } from 'stream'
  export default function bz2(): Duplex
}

declare module 'tar-fs' {
  import type { Writable } from 'stream'
  export function extract(dest: string): Writable
}
