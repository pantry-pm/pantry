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

interface StreamTiming {
  now: () => number
  sleep: (milliseconds: number) => Promise<unknown>
}

function positiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const parsed = Number.parseInt(value, 10)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

export async function* rateLimitStream(
  stream: AsyncIterable<Uint8Array>,
  bytesPerSecond: number,
  timing: StreamTiming = {
    now: () => performance.now(),
    sleep: milliseconds => Bun.sleep(milliseconds),
  },
): AsyncGenerator<Uint8Array> {
  const startedAt = timing.now()
  let total = 0
  for await (const chunk of stream) {
    total += chunk.byteLength
    yield chunk
    const targetElapsedMs = total / bytesPerSecond * 1000
    const delayMs = targetElapsedMs - (timing.now() - startedAt)
    if (delayMs > 0)
      await timing.sleep(delayMs)
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
  const bytesPerSecond = positiveInt(
    process.env.PANTRY_SCANNER_DOWNLOAD_BYTES_PER_SECOND,
    8 * 1024 * 1024,
  )
  const result = await scanner.scanStream(rateLimitStream(responseStream, bytesPerSecond), {
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
