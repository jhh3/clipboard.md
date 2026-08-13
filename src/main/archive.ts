import { pipeline as streamPipeline } from 'stream/promises'

/**
 * Extract a .tar.bz2 stream, without a `tar` binary and without touching disk twice.
 *
 * `tar xjf` was wrong twice over. Windows ships bsdtar as `tar.exe`, and it is not
 * reliably built with bzip2 — it fails with "Unrecognized archive format", which our
 * catch swallowed into the single line "[transcribe] local model setup failed". The
 * user is then told the model setup failed after a 490MB download, with nothing
 * naming the actual cause, and retrying downloads it all again.
 *
 * Doing it in-process also means the archive is never written at all: the HTTP
 * response streams straight through the decompressor into the extractor, so a
 * feature that used to need 980MB of free space now needs 490MB. That is a change on
 * Linux and macOS too, and a good one — it is the same bytes through the same
 * pipeline, verified against `tar xjf` output in transcribe.test.ts.
 */
export async function extractTarBz2(source: NodeJS.ReadableStream, dest: string): Promise<void> {
  const [{ default: bz2 }, { default: tarFs }] = await Promise.all([
    import('unbzip2-stream'),
    import('tar-fs')
  ])
  await streamPipeline(source, bz2(), tarFs.extract(dest))
}
