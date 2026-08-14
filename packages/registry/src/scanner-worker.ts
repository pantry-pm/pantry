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

import { ClamAvScanner } from './malware-scanning'

interface WorkerInput {
  url: string
  expected: { sha256: string, size: number }
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
  const result = await scanner.scanStream(responseStream, {
    surface: 'binary',
    name: '_isolated',
  }, input.expected)
  process.stdout.write(JSON.stringify(result))
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`Isolated scanner failed: ${(error as Error).message}`)
    process.exit(1)
  })
}
