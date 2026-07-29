import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { InMemoryAnalytics } from './analytics'
import { InMemoryAuthStorage } from './auth'
import {
  BinaryArtifactPublisher,
  BinaryPublishError,
  filterBinaryMetadataForCleanScans,
  type BinaryArtifactStore,
} from './binary-publishing'
import {
  type MalwareScanContext,
  type MalwareScanResult,
  type MalwareScanner,
  type MalwareScannerHealth,
} from './malware-scanning'
import { createLocalRegistry } from './registry'
import { createServer } from './server'
import { getAvailablePort } from './test-utils'
import { InMemoryZigStorage } from './zig'

class MemoryArtifactStore implements BinaryArtifactStore {
  files = new Map<string, Buffer>()
  lastUploadKey = ''

  async getObject(key: string): Promise<Buffer> {
    const value = this.files.get(key)
    if (!value) throw new Error(`not found: ${key}`)
    return Buffer.from(value)
  }

  async getObjectStream(key: string): Promise<AsyncIterable<Uint8Array>> {
    const value = await this.getObject(key)
    return {
      async *[Symbol.asyncIterator]() {
        const midpoint = Math.ceil(value.byteLength / 2)
        yield value.subarray(0, midpoint)
        yield value.subarray(midpoint)
      },
    }
  }

  async putObject(key: string, body: Buffer | string, _contentType: string): Promise<void> {
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

class TestScanner implements MalwareScanner {
  readonly enabled = true
  readonly required = true
  contexts: MalwareScanContext[] = []

  constructor(private verdict: MalwareScanResult['verdict'] = 'clean') {}

  async scan(data: ArrayBuffer, context: MalwareScanContext): Promise<MalwareScanResult> {
    this.contexts.push(context)
    return {
      verdict: this.verdict,
      engine: 'test-scanner',
      scannedAt: new Date().toISOString(),
      durationMs: 1,
      artifactSha256: createHash('sha256').update(Buffer.from(data)).digest('hex'),
      ...(this.verdict === 'blocked' ? { signature: 'Test.EICAR' } : {}),
      ...(this.verdict === 'error' ? { reason: 'scanner offline' } : {}),
    }
  }

  async scanStream(
    data: AsyncIterable<Uint8Array>,
    context: MalwareScanContext,
    expected: { sha256: string, size: number },
  ): Promise<MalwareScanResult> {
    const chunks: Buffer[] = []
    for await (const chunk of data) chunks.push(Buffer.from(chunk))
    const bytes = Buffer.concat(chunks)
    if (bytes.byteLength !== expected.size)
      throw new Error('test stream size mismatch')
    return this.scan(Uint8Array.from(bytes).buffer, context)
  }

  async health(): Promise<MalwareScannerHealth> {
    return { enabled: true, required: true, ready: true, engine: 'test-scanner' }
  }
}

function request(bytes: Buffer, platforms = ['darwin-arm64']) {
  return {
    domain: 'example.com/tool',
    version: '1.2.3',
    platforms,
    filename: 'example.com-tool-1.2.3.tar.gz',
    size: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
}

describe('binary scan-before-promote publisher', () => {
  it('promotes clean bytes, writes attestations, and indexes metadata last', async () => {
    const store = new MemoryArtifactStore()
    const scanner = new TestScanner()
    const publisher = new BinaryArtifactPublisher(store, scanner, {
      tokenSecret: 'test-secret-that-is-long-enough',
    })
    const bytes = Buffer.from('clean artifact')
    const initiated = publisher.initiate(request(bytes, ['darwin-arm64', 'linux-x86-64']))
    await store.putObject(store.lastUploadKey, bytes, 'application/gzip')

    const result = await publisher.complete(initiated.uploadId, '_admin')

    expect(result.scan.verdict).toBe('clean')
    expect(Object.keys(result.platforms)).toEqual(['darwin-arm64', 'linux-x86-64'])
    for (const record of Object.values(result.platforms)) {
      expect(store.files.get(record.tarball)?.toString()).toBe('clean artifact')
      expect(JSON.parse(store.files.get(`${record.tarball}.scan.json`)!.toString()).scan.verdict).toBe('clean')
    }
    const metadata = JSON.parse(store.files.get('binaries/example.com/tool/metadata.json')!.toString())
    expect(metadata.versions['1.2.3'].platforms['darwin-arm64'].malwareScan.verdict).toBe('clean')
    expect(store.files.has(store.lastUploadKey)).toBe(false)
    expect(scanner.contexts[0]).toEqual({
      surface: 'binary',
      name: 'example.com/tool',
      version: '1.2.3',
      publisher: '_admin',
    })
  })

  it('never creates installable keys for blocked bytes', async () => {
    const store = new MemoryArtifactStore()
    const publisher = new BinaryArtifactPublisher(store, new TestScanner('blocked'), {
      tokenSecret: 'test-secret-that-is-long-enough',
    })
    const bytes = Buffer.from('EICAR')
    const initiated = publisher.initiate(request(bytes))
    await store.putObject(store.lastUploadKey, bytes, 'application/gzip')

    await expect(publisher.complete(initiated.uploadId)).rejects.toMatchObject({
      code: 'MALWARE_DETECTED',
      status: 422,
    })
    expect([...store.files.keys()].filter(key => key.startsWith('binaries/'))).toEqual([])
    expect(store.files.has(store.lastUploadKey)).toBe(false)
  })

  it('fails closed and cleans staging when the scanner is unavailable', async () => {
    const store = new MemoryArtifactStore()
    const publisher = new BinaryArtifactPublisher(store, new TestScanner('error'), {
      tokenSecret: 'test-secret-that-is-long-enough',
    })
    const bytes = Buffer.from('unknown')
    const initiated = publisher.initiate(request(bytes))
    await store.putObject(store.lastUploadKey, bytes, 'application/gzip')
    await expect(publisher.complete(initiated.uploadId)).rejects.toMatchObject({
      code: 'MALWARE_SCAN_UNAVAILABLE',
      status: 503,
    })
    expect(store.files.size).toBe(0)
  })

  it('rejects size, digest, token tampering, and expired uploads', async () => {
    const store = new MemoryArtifactStore()
    let now = Date.now()
    const publisher = new BinaryArtifactPublisher(store, new TestScanner(), {
      tokenSecret: 'test-secret-that-is-long-enough',
      stagingTtlSeconds: 1,
      now: () => now,
    })
    const bytes = Buffer.from('artifact')
    const initiated = publisher.initiate(request(bytes))
    await store.putObject(store.lastUploadKey, Buffer.from('different'), 'application/gzip')
    await expect(publisher.complete(initiated.uploadId)).rejects.toMatchObject({ code: 'BINARY_SIZE_MISMATCH' })

    const digestMismatch = publisher.initiate(request(bytes))
    await store.putObject(store.lastUploadKey, Buffer.from('artifacx'), 'application/gzip')
    await expect(publisher.complete(digestMismatch.uploadId)).rejects.toMatchObject({ code: 'BINARY_SHA256_MISMATCH' })
    await expect(publisher.complete(`${initiated.uploadId}x`)).rejects.toBeInstanceOf(BinaryPublishError)

    const expiring = publisher.initiate(request(bytes))
    now += 2_000
    await expect(publisher.complete(expiring.uploadId)).rejects.toMatchObject({ code: 'BINARY_UPLOAD_EXPIRED' })
  })

  it('is idempotent after successful promotion', async () => {
    const store = new MemoryArtifactStore()
    const publisher = new BinaryArtifactPublisher(store, new TestScanner(), {
      tokenSecret: 'test-secret-that-is-long-enough',
    })
    const bytes = Buffer.from('artifact')
    const initiated = publisher.initiate(request(bytes))
    await store.putObject(store.lastUploadKey, bytes, 'application/gzip')
    const first = await publisher.complete(initiated.uploadId)
    const second = await publisher.complete(initiated.uploadId)
    expect(second.scan.artifactSha256).toBe(first.scan.artifactSha256)
  })

  it('filters unattested metadata without mutating the stored snapshot', () => {
    const clean = {
      verdict: 'clean' as const,
      engine: 'test',
      scannedAt: new Date().toISOString(),
      durationMs: 1,
      artifactSha256: 'a'.repeat(64),
    }
    const metadata: any = {
      name: 'example.com/tool',
      latestVersion: '2.0.0',
      versions: {
        '1.0.0': { platforms: { 'darwin-arm64': { malwareScan: clean } } },
        '2.0.0': { platforms: { 'linux-x86-64': {} } },
      },
      updatedAt: new Date().toISOString(),
    }
    const filtered = filterBinaryMetadataForCleanScans(metadata)
    expect(Object.keys(filtered.versions)).toEqual(['1.0.0'])
    expect(filtered.latestVersion).toBe('1.0.0')
    expect(metadata.versions['2.0.0']).toBeTruthy()
  })
})

describe('binary publication API', () => {
  let server: ReturnType<typeof createServer>
  let baseUrl: string
  let token: string
  let store: MemoryArtifactStore

  beforeEach(async () => {
    token = `binary-test-${crypto.randomUUID()}`
    process.env.PANTRY_REGISTRY_TOKEN = token
    const port = await getAvailablePort()
    baseUrl = `http://localhost:${port}`
    store = new MemoryArtifactStore()
    const scanner = new TestScanner()
    const publisher = new BinaryArtifactPublisher(store, scanner, {
      tokenSecret: 'test-secret-that-is-long-enough',
    })
    server = createServer(
      createLocalRegistry(baseUrl),
      port,
      new InMemoryAnalytics(),
      new InMemoryZigStorage(),
      undefined,
      undefined,
      new InMemoryAuthStorage(),
      scanner,
      publisher,
    )
    server.start()
  })

  afterEach(() => {
    server.stop()
    delete process.env.PANTRY_REGISTRY_TOKEN
  })

  it('requires operator auth and completes a staged publication', async () => {
    const bytes = Buffer.from('api artifact')
    const unauthenticated = await fetch(`${baseUrl}/api/v1/binaries/uploads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request(bytes)),
    })
    expect(unauthenticated.status).toBe(401)

    const initiatedResponse = await fetch(`${baseUrl}/api/v1/binaries/uploads`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(request(bytes)),
    })
    expect(initiatedResponse.status).toBe(201)
    const initiated = await initiatedResponse.json() as any
    await store.putObject(store.lastUploadKey, bytes, 'application/gzip')

    const completed = await fetch(`${baseUrl}/api/v1/binaries/uploads/complete`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploadId: initiated.uploadId }),
    })
    expect(completed.status).toBe(201)
    expect((await completed.json() as any).scan.verdict).toBe('clean')
  })
})
