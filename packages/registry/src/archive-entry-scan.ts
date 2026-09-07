/**
 * Entry-wise scanning for archives ClamAV will not cover in one pass.
 *
 * clamd bounds what a single scan may open: `MaxFileSize` caps any one member,
 * `MaxFiles` caps how many it will look at, `MaxScanSize` caps the total. With
 * `AlertExceedsMax yes` it reports the shortfall as
 * `Heuristics.Limits.Exceeded.*` rather than silently skipping the remainder —
 * a fail-closed non-verdict, correctly, because "I did not look at all of it"
 * is not "it is clean".
 *
 * Raising the limits is not always the answer: a single member larger than the
 * INSTREAM protocol's own ceiling cannot be scanned whole at any setting. The
 * answer is to hand the engine one archive member at a time, which is strictly
 * MORE coverage than the whole-archive pass that gave up partway.
 *
 * This is the same technique `backfill-malware-scans.ts` already uses for
 * retained artifacts; it lives here so the publish path and the backfill share
 * one implementation rather than two that drift.
 */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'
import { extract } from 'tar-stream'
import { isScanCoverageLimitReason } from './malware-scanning'
import type { MalwareScanContext, MalwareScanResult, MalwareScanner } from './malware-scanning'

/**
 * Entry and byte ceilings for the unpacked archive.
 *
 * These are decompression-bomb guards, not coverage limits: they are far above
 * anything we publish (the largest artifact we accept is 1 GiB compressed) and
 * exist so a hostile archive cannot make this loop run forever. Exceeding one
 * is an error, never a clean verdict.
 */
/**
 * Size at which the whole-archive pass stops being worth attempting.
 *
 * Derived, not chosen. `solr.apache.org` at 386 MB scanned clean in 1,061,297
 * ms — about 2.7 s per compressed megabyte — and the largest budget any scan
 * gets is MAX_SCAN_TIMEOUT_MS (45 min). 2700 s / 2.7 s per MB puts the
 * break-even at roughly 1 GB: above it the single pass is a foregone
 * `Heuristics.Limits.Exceeded` (clamd's MaxScanTime lands in the same family)
 * that costs the entire budget to arrive at.
 *
 * Below it, one INSTREAM beats thousands. Above it, going straight to members
 * is both faster and more thorough — measured on the real llvm.org 23.1.0
 * darwin-arm64 artifact (1576 MB compressed, 5.68 GB unpacked): 11,116
 * members, largest 192 MB, walked in 15 s at a peak RSS of 94 MB.
 */
export const OVERSIZED_ARCHIVE_BYTES: number = 1024 * 1024 * 1024

export const MAX_ARCHIVE_ENTRY_COUNT: number = 1_000_000
export const MAX_ARCHIVE_UNPACKED_BYTES: number = 16 * 1024 * 1024 * 1024

export interface ArchiveEntryScanOptions {
  /** Digest of the archive itself, which the per-entry scans cannot produce. */
  artifactSha256: string
  maxEntries?: number
  maxUnpackedBytes?: number
  /** Called once with the entry/byte totals, for the caller's own logging. */
  onComplete?: (summary: { entries: number, unpackedBytes: number }) => void
}

/**
 * Scan every regular file in a gzip-compressed tar, one member at a time.
 *
 * The archive is never extracted to the filesystem: each member is handed to
 * the scanner as a bounded stream and discarded. `allowDigestMismatch` is set
 * because the digest that matters is the archive's, which the caller supplies
 * — an individual member has no digest anyone has attested to.
 */
export async function scanArchiveEntries(
  archivePath: string,
  context: MalwareScanContext,
  scanner: Pick<MalwareScanner, 'scanStream'>,
  options: ArchiveEntryScanOptions,
): Promise<MalwareScanResult> {
  if (!scanner.scanStream)
    throw new Error('entry-wise archive scanning requires a streaming scanner')

  const maxEntries = options.maxEntries ?? MAX_ARCHIVE_ENTRY_COUNT
  const maxUnpackedBytes = options.maxUnpackedBytes ?? MAX_ARCHIVE_UNPACKED_BYTES
  const startedAt = performance.now()
  const scannedAt = new Date().toISOString()

  try {
    const unpack = extract()
    let entries = 0
    let unpackedBytes = 0
    // Kept so the archive verdict can carry the engine and database versions
    // that produced it; every entry is scanned by the same daemon.
    let representative: MalwareScanResult | undefined
    let blocked: MalwareScanResult | undefined

    unpack.on('entry', (header, stream, next) => {
      void (async () => {
        if (header.type !== 'file' && header.type !== 'contiguous-file') {
          stream.once('end', next)
          stream.resume()
          return
        }
        const entrySize = header.size
        if (typeof entrySize !== 'number' || !Number.isSafeInteger(entrySize) || entrySize < 0)
          throw new Error('archive contained an invalid regular-file size')
        entries += 1
        unpackedBytes += entrySize
        if (entries > maxEntries)
          throw new Error(`archive exceeded ${maxEntries} entries`)
        if (unpackedBytes > maxUnpackedBytes)
          throw new Error(`archive exceeded ${maxUnpackedBytes} unpacked bytes`)

        const entryScan = await scanner.scanStream!(stream, context, {
          sha256: '0'.repeat(64),
          size: entrySize,
          allowDigestMismatch: true,
        })
        representative ||= entryScan
        // An entry the engine could not scan leaves the archive uncovered, so
        // it fails closed exactly as the whole-archive pass would have.
        if (entryScan.verdict === 'error')
          throw new Error(entryScan.reason || 'scanner returned an error for an archive entry')
        if (entryScan.verdict === 'blocked')
          blocked ||= entryScan
        next()
      })().catch(error => unpack.destroy(error as Error))
    })

    await pipeline(createReadStream(archivePath), createGunzip(), unpack)
    if (!representative)
      throw new Error('archive contained no regular files to scan')
    options.onComplete?.({ entries, unpackedBytes })

    return {
      verdict: blocked ? 'blocked' : 'clean',
      engine: 'clamav',
      scannedAt,
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      artifactSha256: options.artifactSha256,
      ...(blocked?.signature ? { signature: blocked.signature } : {}),
      ...(representative.engineVersion ? { engineVersion: representative.engineVersion } : {}),
      ...(representative.databaseVersion ? { databaseVersion: representative.databaseVersion } : {}),
    }
  }
  catch (error) {
    return {
      verdict: 'error',
      engine: 'clamav',
      scannedAt,
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      artifactSha256: options.artifactSha256,
      reason: `archive-entry scan failed: ${(error as Error).message || String(error)}`,
    }
  }
}

/**
 * Scan a staged archive whole, falling back to member-by-member on a coverage
 * limit.
 *
 * Lives here rather than inline in the worker so the decision — which is the
 * whole point of staging the artifact on disk — is testable without an HTTPS
 * origin and a live clamd.
 */
export async function scanArchiveWithEntryFallback(
  archivePath: string,
  context: MalwareScanContext,
  scanner: Pick<MalwareScanner, 'scanStream'>,
  expected: { sha256: string, size: number },
  options: {
    openArchive: () => AsyncIterable<Uint8Array> | NodeJS.ReadableStream
    /** At or above this size, skip the whole-archive pass entirely. */
    oversizedBytes?: number
  },
): Promise<MalwareScanResult> {
  if (!scanner.scanStream)
    throw new Error('archive scanning requires a streaming scanner')

  // Above this size the whole-archive pass is not a scan, it is a way of
  // spending the entire budget to be told the archive was too big to cover.
  // clamd's own MaxScanTime and MaxScanSize both land in the same
  // Heuristics.Limits.Exceeded family, so the outcome is known in advance —
  // go straight to the member-by-member pass, as the backfill already does
  // for retained artifacts of this size.
  const oversizedBytes = options.oversizedBytes ?? OVERSIZED_ARCHIVE_BYTES
  if (expected.size >= oversizedBytes) {
    return scanArchiveEntries(archivePath, context, scanner, {
      artifactSha256: expected.sha256,
    })
  }

  const whole = await scanner.scanStream(options.openArchive() as AsyncIterable<Uint8Array>, context, expected)

  // clamd covered only part of the archive and said so. That is not a
  // transient failure and not a detection — it is "I did not look at all of
  // it", which fails closed. Handing it one member at a time is strictly more
  // coverage than the pass that gave up, and it is the only way past a member
  // larger than the engine's own per-file ceiling.
  if (whole.verdict !== 'error' || !isScanCoverageLimitReason(whole.reason))
    return whole

  const entryScan = await scanArchiveEntries(archivePath, context, scanner, {
    artifactSha256: expected.sha256,
  })
  // Report BOTH: the entry scan's own failure alone would hide which engine
  // limit sent us down this path in the first place.
  return entryScan.verdict === 'error'
    ? { ...entryScan, reason: `${entryScan.reason} (after ${whole.reason})` }
    : entryScan
}

/**
 * Stream `source` to `sink`, enforcing the declared size and returning the
 * digest of what actually arrived.
 *
 * Both checks matter to a scan: a truncated download would otherwise be
 * scanned and pronounced clean, and the digest is what binds the verdict to
 * the bytes the registry is about to promote.
 */
export async function writeVerifiedArtifact(
  source: AsyncIterable<Uint8Array>,
  sink: NodeJS.WritableStream,
  expectedSize: number,
): Promise<string> {
  const hash = createHash('sha256')
  let size = 0
  async function* verified(): AsyncGenerator<Uint8Array> {
    for await (const chunk of source) {
      size += chunk.byteLength
      if (size > expectedSize)
        throw new Error('artifact download exceeded its declared size')
      hash.update(chunk)
      yield chunk
    }
  }
  await pipeline(verified(), sink)
  if (size !== expectedSize)
    throw new Error('artifact download size did not match its declared size')
  return hash.digest('hex')
}
