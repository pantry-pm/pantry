import type { BinaryArtifactStore } from './binary-publishing'
import type { MalwareScanContext, MalwareScanner, MalwareScannerHealth, MalwareScanResult } from './malware-scanning'
import { describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { BinaryArtifactPublisher, digestAttestationKey, reusableCleanScan, scanFailureBackoffMs } from './binary-publishing'

class MemoryArtifactStore implements BinaryArtifactStore {
  files = new Map<string, Buffer>()
  lastUploadKey = ''

  async getObject(key: string): Promise<Buffer> {
    const value = this.files.get(key)
    if (!value) throw new Error(`not found: ${key}`)
    return Buffer.from(value)
  }

  async putObject(key: string, body: Buffer | string): Promise<void> {
    this.files.set(key, typeof body === 'string' ? Buffer.from(body) : Buffer.from(body))
  }

  async copyObject(sourceKey: string, destinationKey: string): Promise<void> {
    this.files.set(destinationKey, await this.getObject(sourceKey))
  }

  async deleteObject(key: string): Promise<void> {
    this.files.delete(key)
  }

  async headObject(key: string): Promise<Record<string, string>> {
    const value = await this.getObject(key)
    return { 'content-length': String(value.byteLength) }
  }

  createUploadUrl(key: string): string {
    this.lastUploadKey = key
    return `memory://${encodeURIComponent(key)}`
  }
}

class CountingScanner implements MalwareScanner {
  readonly enabled = true
  readonly required = true
  scans = 0
  verdict: MalwareScanResult['verdict'] = 'clean'

  async scan(data: ArrayBuffer, _context: MalwareScanContext): Promise<MalwareScanResult> {
    this.scans++
    return {
      verdict: this.verdict,
      engine: 'test-scanner',
      scannedAt: new Date().toISOString(),
      durationMs: 1,
      artifactSha256: createHash('sha256').update(Buffer.from(data)).digest('hex'),
    }
  }

  async health(): Promise<MalwareScannerHealth> {
    return { enabled: true, required: true, ready: true, engine: 'test-scanner' }
  }
}

function publishRequest(bytes: Buffer, version: string, platforms = ['darwin-arm64']) {
  return {
    domain: 'example.com/tool',
    version,
    platforms,
    filename: `example.com-tool-${version}.tar.gz`,
    size: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
}

async function publish(publisher: BinaryArtifactPublisher, store: MemoryArtifactStore, bytes: Buffer, version: string) {
  const initiated = publisher.initiate(publishRequest(bytes, version))
  await store.putObject(store.lastUploadKey, bytes)
  return publisher.complete(initiated.uploadId, '_admin')
}

describe('digest-keyed scan attestation reuse', () => {
  it('scans identical bytes once across republishes', async () => {
    const store = new MemoryArtifactStore()
    const scanner = new CountingScanner()
    const publisher = new BinaryArtifactPublisher(store, scanner, { tokenSecret: 'test-secret-that-is-long-enough' })
    const bytes = Buffer.from('an artifact republished by a mirror sweep')

    const first = await publish(publisher, store, bytes, '1.2.3')
    const second = await publish(publisher, store, bytes, '1.2.4')

    expect(first.scan.verdict).toBe('clean')
    expect(second.scan.verdict).toBe('clean')
    expect(scanner.scans).toBe(1)
    expect(store.files.has(digestAttestationKey(first.scan.artifactSha256))).toBe(true)
  })

  it('still scans bytes it has never seen', async () => {
    const store = new MemoryArtifactStore()
    const scanner = new CountingScanner()
    const publisher = new BinaryArtifactPublisher(store, scanner, { tokenSecret: 'test-secret-that-is-long-enough' })

    await publish(publisher, store, Buffer.from('artifact one'), '1.2.3')
    await publish(publisher, store, Buffer.from('artifact two'), '1.2.4')

    expect(scanner.scans).toBe(2)
  })

  it('still writes the per-tarball attestation for a reused verdict', async () => {
    const store = new MemoryArtifactStore()
    const scanner = new CountingScanner()
    const publisher = new BinaryArtifactPublisher(store, scanner, { tokenSecret: 'test-secret-that-is-long-enough' })
    const bytes = Buffer.from('an artifact republished by a mirror sweep')

    await publish(publisher, store, bytes, '1.2.3')
    const second = await publish(publisher, store, bytes, '1.2.4')

    for (const record of Object.values(second.platforms)) {
      const attestation = JSON.parse(store.files.get(`${record.tarball}.scan.json`)!.toString())
      expect(attestation.scan.verdict).toBe('clean')
    }
  })
})

describe('reusableCleanScan', () => {
  const sha = 'a'.repeat(64)
  const now = Date.parse('2026-08-06T12:00:00.000Z')
  const clean: MalwareScanResult = {
    verdict: 'clean',
    engine: 'clamav',
    scannedAt: '2026-08-06T11:00:00.000Z',
    durationMs: 1234,
    artifactSha256: sha,
  }

  it('accepts a recent clean verdict bound to the digest', () => {
    expect(reusableCleanScan({ scan: clean }, sha, now)).toEqual(clean)
  })

  it('rejects a verdict bound to different bytes', () => {
    expect(reusableCleanScan({ scan: clean }, 'b'.repeat(64), now)).toBeNull()
  })

  it('rejects a non-clean verdict', () => {
    expect(reusableCleanScan({ scan: { ...clean, verdict: 'blocked' } }, sha, now)).toBeNull()
  })

  it('rejects a verdict older than the reuse window', () => {
    const stale = { scan: { ...clean, scannedAt: '2026-07-01T00:00:00.000Z' } }
    expect(reusableCleanScan(stale, sha, now)).toBeNull()
  })

  it('rejects a verdict stamped in the future', () => {
    const ahead = { scan: { ...clean, scannedAt: '2026-09-01T00:00:00.000Z' } }
    expect(reusableCleanScan(ahead, sha, now)).toBeNull()
  })

  it('rejects malformed and empty payloads', () => {
    expect(reusableCleanScan(null, sha, now)).toBeNull()
    expect(reusableCleanScan({}, sha, now)).toBeNull()
    expect(reusableCleanScan({ scan: { ...clean, engine: '' } }, sha, now)).toBeNull()
    expect(reusableCleanScan({ scan: { ...clean, durationMs: -1 } }, sha, now)).toBeNull()
    expect(reusableCleanScan({ scan: { ...clean, scannedAt: 'not-a-date' } }, sha, now)).toBeNull()
  })
})

describe('scan failure backoff', () => {
  it('grows the wait with each consecutive failure and then caps it', () => {
    expect(scanFailureBackoffMs(1)).toBe(15 * 60 * 1000)
    expect(scanFailureBackoffMs(2)).toBe(30 * 60 * 1000)
    expect(scanFailureBackoffMs(3)).toBe(60 * 60 * 1000)
    expect(scanFailureBackoffMs(50)).toBe(6 * 60 * 60 * 1000)
  })

  it('refuses a repeat publish without re-downloading the artifact', async () => {
    const store = new MemoryArtifactStore()
    const scanner = new CountingScanner()
    scanner.verdict = 'error'
    const publisher = new BinaryArtifactPublisher(store, scanner, { tokenSecret: 'test-secret-that-is-long-enough' })
    const bytes = Buffer.from('an artifact whose scan never finishes')

    await expect(publish(publisher, store, bytes, '1.2.3')).rejects.toThrow(/temporarily unavailable/)
    expect(scanner.scans).toBe(1)

    await expect(publish(publisher, store, bytes, '1.2.4')).rejects.toThrow(/retry in \d+s/)
    expect(scanner.scans).toBe(1)
  })

  it('clears the backoff once a scan reaches a verdict', async () => {
    const store = new MemoryArtifactStore()
    const scanner = new CountingScanner()
    scanner.verdict = 'error'
    let clockOffsetMs = 0
    const publisher = new BinaryArtifactPublisher(store, scanner, {
      tokenSecret: 'test-secret-that-is-long-enough',
      now: () => Date.now() + clockOffsetMs,
    })
    const bytes = Buffer.from('an artifact that eventually scans')

    await expect(publish(publisher, store, bytes, '1.2.3')).rejects.toThrow()

    clockOffsetMs = 16 * 60 * 1000
    scanner.verdict = 'clean'
    const result = await publish(publisher, store, bytes, '1.2.4')

    expect(result.scan.verdict).toBe('clean')
    expect(scanner.scans).toBe(2)
  })
})
