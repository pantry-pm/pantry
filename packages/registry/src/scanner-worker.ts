#!/usr/bin/env bun

/**
 * Isolated native-artifact scanner.
 *
 * The Registry passes only a short-lived presigned GET URL and the immutable
 * size/digest it already loaded from metadata. Running the S3/hash/clamd relay
 * in this low-priority child keeps a large scan off the serving event loop.
 * The parent Registry still validates the result and owns all attestation,
 * promotion, and quarantine writes.
 */

import { createReadStream, createWriteStream, mkdirSync, mkdtempSync, rmSync, statfsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanArchiveWithEntryFallback, writeVerifiedArtifact } from './archive-entry-scan'
import { ClamAvScanner } from './malware-scanning'

interface WorkerInput {
  url: string
  expected: { sha256: string, size: number }
}

function positiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const parsed = Number.parseInt(value, 10)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

/*
 * There is deliberately no download rate limiter here any more.
 *
 * One used to wrap this stream, pacing consumption to 8 MB/s. It never limited
 * a download: `fetch` pulls the body off the network at link speed and queues
 * it internally regardless of how slowly anything reads, so the only thing the
 * pacing changed was how long those bytes sat in this process. Measured on a
 * 1 GB artifact, same code and same clamd, it cost 4x the memory (2030 MB peak
 * against 529 MB) and 25x the wall clock (156s against 6.1s) — and the extra
 * 150 seconds outlived the presigned URL often enough to produce its own class
 * of failure: scans ending in `artifact download failed with HTTP 403`.
 *
 * Nothing on the network side changes by removing it, because the download was
 * always running at full speed. If artifact fetches ever do need pacing — to
 * keep a scan from crowding the uplink it shares with every other tenant — it
 * has to happen where the bytes are pulled: ranged GETs of a bounded window,
 * paced between windows. That limits the transfer AND bounds memory to one
 * window. Pacing the consumer does neither.
 */

/**
 * A directory with room for `size` bytes, or null to scan without staging.
 *
 * The space check is a preflight rather than a try/catch around the write,
 * because a write that fails halfway has already consumed the response body —
 * and recovering from that costs a second full download of the artifact,
 * against a bucket allowance we have exhausted once already.
 */
export function prepareScratchDirectory(size: number): string | null {
  const root = process.env.PANTRY_SCANNER_SCRATCH_DIR || tmpdir()
  try {
    mkdirSync(root, { recursive: true })
    // 10% headroom: the artifact, plus whatever else shares the volume moving
    // underneath us while it is written.
    const stats = statfsSync(root)
    const available = stats.bavail * stats.bsize
    if (Number.isFinite(available) && available < size * 1.1) {
      console.error(
        `Scanner scratch at ${root} has ${available} bytes free for a ${size}-byte artifact; `
        + 'scanning without staging (entry-wise retry unavailable)',
      )
      return null
    }
    return mkdtempSync(join(root, 'pantry-isolated-scan-'))
  }
  catch (error) {
    console.error(`Scanner scratch at ${root} unusable (${(error as Error).message}); scanning without staging`)
    return null
  }
}

async function main(): Promise<void> {
  const input = JSON.parse(await Bun.stdin.text()) as WorkerInput
  if (
    typeof input.url !== 'string'
    || !input.url.startsWith('https://')
    || !Number.isSafeInteger(input.expected?.size)
    || input.expected.size < 0
    || !/^[a-f0-9]{64}$/.test(input.expected?.sha256 || '')
  ) {
    throw new Error('invalid isolated scanner input')
  }

  const timeoutMs = positiveInt(process.env.CLAMD_TIMEOUT_MS, 30_000)
  const response = await fetch(input.url, {
    method: 'GET',
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok || !response.body)
    throw new Error(`artifact download failed with HTTP ${response.status}`)

  const contentLength = Number.parseInt(response.headers.get('content-length') || '', 10)
  if (Number.isSafeInteger(contentLength) && contentLength !== input.expected.size)
    throw new Error('artifact download size did not match the declared size')

  const scanner = new ClamAvScanner({
    socketPath: process.env.CLAMD_SOCKET,
    host: process.env.CLAMD_HOST || '127.0.0.1',
    port: positiveInt(process.env.CLAMD_PORT, 3310),
    timeoutMs,
    healthTimeoutMs: positiveInt(process.env.CLAMD_HEALTH_TIMEOUT_MS, 5_000),
    maxBytes: positiveInt(process.env.CLAMD_MAX_BYTES, 1024 * 1024 * 1024),
    chunkBytes: positiveInt(process.env.CLAMD_CHUNK_BYTES, 64 * 1024),
  })
  const reader = response.body.getReader()
  const responseStream = {
    async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        yield chunk.value
      }
    },
  }
  const context = { surface: 'binary', name: '_isolated' } as const

  // The artifact is written to this worker's own temp directory before it is
  // scanned, rather than streamed straight into clamd.
  //
  // The reason is the fallback below: an archive clamd could not cover in one
  // pass has to be read a SECOND time, member by member. Streaming leaves no
  // second copy, so the only alternatives are re-downloading the artifact —
  // paying its egress twice, against a bucket allowance we have already
  // exhausted once — or abandoning the retry. A bounded file on local disk is
  // the cheap side of that trade: DEFAULT_MAX_BINARY_BYTES caps artifacts at
  // 4 GiB and the scanner admits two at a time, so the volume needs 8 GiB in
  // the worst case, and each file is removed in `finally` whatever happens.
  //
  // PANTRY_SCANNER_SCRATCH_DIR must point at DISK. The default, the host's
  // /tmp, is a tmpfs on some distributions, and a tmpfs file is charged to
  // this unit's cgroup — against a MemoryMax of 1G, staging a 1 GiB artifact
  // there would kill the worker outright.
  //
  // Staging is an ENHANCEMENT, never a requirement. If the directory cannot be
  // made or the volume has no room, scanning falls back to streaming the
  // download straight into clamd — exactly what this worker did before — and
  // loses only the entry-wise retry. Making it mandatory would mean a host
  // whose disk is too small stops publishing ENTIRELY, trading a capability
  // for an outage.
  const directory = prepareScratchDirectory(input.expected.size)
  if (!directory) {
    process.stdout.write(JSON.stringify(
      await scanner.scanStream(responseStream, context, input.expected),
    ))
    return
  }

  const archive = join(directory, 'artifact.tar.gz')
  try {
    const artifactSha256 = await writeVerifiedArtifact(
      responseStream,
      createWriteStream(archive, { flags: 'wx' }),
      input.expected.size,
    )

    // Checked here rather than left to the scan. scanStream would also catch
    // it, but only as a scanner error — and "the bytes are not the bytes you
    // claimed" deserves to say so, because the entry-wise fallback below
    // attests its verdict against the DECLARED digest and must never do that
    // for an artifact that did not match.
    if (artifactSha256 !== input.expected.sha256)
      throw new Error('artifact download digest did not match the declared sha256')

    const result = await scanArchiveWithEntryFallback(
      archive,
      context,
      scanner,
      input.expected,
      { openArchive: () => createReadStream(archive) },
    )
    process.stdout.write(JSON.stringify(result))
  }
  finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`Isolated scanner failed: ${(error as Error).message}`)
    process.exit(1)
  })
}
