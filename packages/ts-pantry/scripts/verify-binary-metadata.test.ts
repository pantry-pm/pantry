import { describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { rebuildMetadataFromObjects, verifyBinaryMetadata } from './verify-binary-metadata.ts'

class FakeS3 {
  objects = new Map<string, { body: string, size: number, lastModified: string }>()
  deleted: string[] = []

  put(key: string, body: string, size = body.length): void {
    this.objects.set(key, { body, size, lastModified: '2026-05-04T00:00:00.000Z' })
  }

  async listObjects({ prefix = '' }: { bucket: string, prefix?: string }) {
    return {
      objects: [...this.objects.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([Key, value]) => ({ Key, Size: value.size, LastModified: value.lastModified })),
    }
  }

  async getObject(_bucket: string, key: string): Promise<string> {
    const object = this.objects.get(key)
    if (!object) throw new Error(`missing ${key}`)
    return object.body
  }

  async getObjectBytes(_bucket: string, key: string): Promise<Uint8Array> {
    const object = this.objects.get(key)
    if (!object) throw new Error(`missing ${key}`)
    return new TextEncoder().encode(object.body)
  }

  async putObject(options: { key: string, body: string }): Promise<void> {
    this.put(options.key, options.body)
  }

  async headObject(_bucket: string, key: string): Promise<boolean> {
    return this.objects.has(key)
  }

  async deleteObject(_bucket: string, key: string): Promise<void> {
    this.deleted.push(key)
    this.objects.delete(key)
  }
}

describe('verify-binary-metadata', () => {
  it('rebuilds metadata from matching tarballs and ignores stale mismatched artifacts', async () => {
    const s3 = new FakeS3()
    s3.put('binaries/cmake.org/3.24.2/linux-x86-64/cmake.org-3.24.2.tar.gz', 'tarball', 123)
    s3.put('binaries/cmake.org/3.24.2/linux-x86-64/cmake.org-3.24.2.tar.gz.sha256', `${'a'.repeat(64)}  cmake.org-3.24.2.tar.gz\n`)
    s3.put('binaries/cmake.org/3.24.2/linux-x86-64/cmake.org-3.28.4.tar.gz', 'stale', 999)
    s3.put('binaries/cmake.org/3.24.2/linux-x86-64/cmake.org-3.28.4.tar.gz.sha256', `${'b'.repeat(64)}  cmake.org-3.28.4.tar.gz\n`)

    const objects = (await s3.listObjects({ bucket: 'bucket', prefix: 'binaries/cmake.org/' })).objects
    const { metadata, strays, errors } = await rebuildMetadataFromObjects(s3, 'bucket', 'cmake.org', objects)

    expect(errors).toEqual([])
    expect(strays).toEqual([
      'binaries/cmake.org/3.24.2/linux-x86-64/cmake.org-3.28.4.tar.gz',
      'binaries/cmake.org/3.24.2/linux-x86-64/cmake.org-3.28.4.tar.gz.sha256',
    ])
    expect(metadata.versions['3.24.2'].platforms['linux-x86-64']).toMatchObject({
      tarball: 'binaries/cmake.org/3.24.2/linux-x86-64/cmake.org-3.24.2.tar.gz',
      sha256: 'a'.repeat(64),
      size: 123,
    })
  })

  it('repairs metadata and deletes stale objects when requested', async () => {
    const s3 = new FakeS3()
    s3.put('binaries/cmake.org/3.24.2/darwin-arm64/cmake.org-3.24.2.tar.gz', 'tarball', 321)
    s3.put('binaries/cmake.org/3.24.2/darwin-arm64/cmake.org-3.24.2.tar.gz.sha256', `${'c'.repeat(64)}  cmake.org-3.24.2.tar.gz\n`)
    s3.put('binaries/cmake.org/3.24.2/darwin-arm64/cmake.org-3.28.4.tar.gz', 'stale', 999)
    s3.put('binaries/cmake.org/3.24.2/darwin-arm64/cmake.org-3.28.4.tar.gz.sha256', `${'d'.repeat(64)}  cmake.org-3.28.4.tar.gz\n`)
    s3.put('binaries/cmake.org/metadata.json', JSON.stringify({
      name: 'cmake.org',
      latestVersion: '3.28.4',
      versions: {
        '3.24.2': {
          platforms: {
            'darwin-arm64': {
              tarball: 'binaries/cmake.org/3.24.2/darwin-arm64/cmake.org-3.28.4.tar.gz',
              sha256: 'd'.repeat(64),
              size: 999,
              uploadedAt: '2026-05-04T00:00:00.000Z',
            },
          },
        },
      },
      updatedAt: '2026-05-04T00:00:00.000Z',
    }))

    const result = await verifyBinaryMetadata(s3, 'bucket', 'cmake.org', {
      repair: true,
      deleteStrays: true,
    })

    expect(result).toMatchObject({ ok: true, errors: [] })
    expect(result.repaired).toBe(true)
    expect(result.deletedStrays).toHaveLength(2)

    const repaired = JSON.parse(await s3.getObject('bucket', 'binaries/cmake.org/metadata.json'))
    expect(repaired.latestVersion).toBe('3.24.2')
    expect(repaired.versions['3.24.2'].platforms['darwin-arm64'].tarball)
      .toBe('binaries/cmake.org/3.24.2/darwin-arm64/cmake.org-3.24.2.tar.gz')
  })

  it('repairs missing sha256 objects from tarball bytes', async () => {
    const s3 = new FakeS3()
    s3.put('binaries/meilisearch.com/1.34.3/darwin-arm64/meilisearch.com-1.34.3.tar.gz', 'tarball-bytes', 13)

    const result = await verifyBinaryMetadata(s3, 'bucket', 'meilisearch.com', {
      repair: true,
    })

    const expectedSha = createHash('sha256').update(new TextEncoder().encode('tarball-bytes')).digest('hex')
    expect(result.ok).toBe(true)
    expect(result.repairedSha256).toEqual([
      'binaries/meilisearch.com/1.34.3/darwin-arm64/meilisearch.com-1.34.3.tar.gz.sha256',
    ])
    expect(await s3.getObject('bucket', result.repairedSha256[0])).toContain(expectedSha)

    const repaired = JSON.parse(await s3.getObject('bucket', 'binaries/meilisearch.com/metadata.json'))
    expect(repaired.versions['1.34.3'].platforms['darwin-arm64'].sha256).toBe(expectedSha)
  })

  it('preserves only clean scan attestations that still match the exact artifact record', async () => {
    const s3 = new FakeS3()
    const key = 'binaries/cmake.org/3.24.2/darwin-arm64/cmake.org-3.24.2.tar.gz'
    const sha256 = 'f'.repeat(64)
    s3.put(key, 'tarball', 123)
    s3.put(`${key}.sha256`, `${sha256}  cmake.org-3.24.2.tar.gz\n`)
    s3.put('binaries/cmake.org/metadata.json', JSON.stringify({
      name: 'cmake.org',
      latestVersion: '3.24.2',
      versions: {
        '3.24.2': {
          platforms: {
            'darwin-arm64': {
              tarball: key,
              sha256,
              size: 999,
              uploadedAt: '2026-05-04T00:00:00.000Z',
              malwareScan: {
                verdict: 'clean',
                engine: 'clamav',
                artifactSha256: sha256,
                scannedAt: '2026-05-04T00:00:00.000Z',
                durationMs: 1,
              },
            },
          },
        },
      },
      updatedAt: '2026-05-04T00:00:00.000Z',
    }))

    await verifyBinaryMetadata(s3, 'bucket', 'cmake.org', { repair: true })
    const repaired = JSON.parse(await s3.getObject('bucket', 'binaries/cmake.org/metadata.json'))
    expect(repaired.versions['3.24.2'].platforms['darwin-arm64'].malwareScan).toMatchObject({
      verdict: 'clean',
      artifactSha256: sha256,
    })
  })

  it('recovers digest-bound clean evidence from a durable publish sidecar', async () => {
    const s3 = new FakeS3()
    const key = 'binaries/cmake.org/3.24.2/darwin-arm64/cmake.org-3.24.2.tar.gz'
    const sha256 = 'a'.repeat(64)
    s3.put(key, 'tarball', 123)
    s3.objects.get(key)!.lastModified = '2026-07-30T00:00:00.000Z'
    s3.put(`${key}.sha256`, `${sha256}  cmake.org-3.24.2.tar.gz\n`)
    s3.put(`${key}.scan.json`, JSON.stringify({
      domain: 'cmake.org',
      version: '3.24.2',
      platform: 'darwin-arm64',
      filename: 'cmake.org-3.24.2.tar.gz',
      scan: {
        verdict: 'clean',
        engine: 'clamav',
        artifactSha256: sha256,
        scannedAt: '2026-07-29T23:59:00.000Z',
        durationMs: 42,
      },
    }))
    s3.put('binaries/cmake.org/metadata.json', JSON.stringify({
      name: 'cmake.org',
      latestVersion: '3.24.2',
      versions: {
        '3.24.2': {
          platforms: {
            'darwin-arm64': {
              tarball: key,
              sha256,
              size: 999,
              uploadedAt: '2026-07-30T00:00:00.000Z',
            },
          },
        },
      },
      updatedAt: '2026-07-30T00:00:00.000Z',
    }))

    const result = await verifyBinaryMetadata(s3, 'bucket', 'cmake.org', {
      repair: true,
      requireCleanScanAfter: Date.parse('2026-07-29T00:00:00.000Z'),
    })

    expect(result).toMatchObject({ ok: true, errors: [] })
    const repaired = JSON.parse(await s3.getObject('bucket', 'binaries/cmake.org/metadata.json'))
    expect(repaired.versions['3.24.2'].platforms['darwin-arm64'].malwareScan)
      .toMatchObject({ verdict: 'clean', artifactSha256: sha256 })
  })

  it('refuses to advertise a post-cutoff object without clean durable evidence', async () => {
    const s3 = new FakeS3()
    const key = 'binaries/cmake.org/3.24.2/darwin-arm64/cmake.org-3.24.2.tar.gz'
    s3.put(key, 'unattested bytes', 123)
    s3.objects.get(key)!.lastModified = '2026-07-30T00:00:00.000Z'
    s3.put(`${key}.sha256`, `${'b'.repeat(64)}  cmake.org-3.24.2.tar.gz\n`)

    const result = await verifyBinaryMetadata(s3, 'bucket', 'cmake.org', {
      repair: true,
      requireCleanScanAfter: Date.parse('2026-07-29T00:00:00.000Z'),
    })

    expect(result.ok).toBe(false)
    expect(result.repaired).toBe(false)
    expect(result.errors).toEqual([
      'Missing digest-bound clean malware scan: cmake.org@3.24.2 darwin-arm64',
    ])
    expect(s3.objects.has('binaries/cmake.org/metadata.json')).toBe(false)
  })

  it('requires every retained artifact to be attested in strict mode', async () => {
    const s3 = new FakeS3()
    const key = 'binaries/cmake.org/3.24.2/darwin-arm64/cmake.org-3.24.2.tar.gz'
    s3.put(key, 'legacy unattested bytes', 123)
    s3.put(`${key}.sha256`, `${'c'.repeat(64)}  cmake.org-3.24.2.tar.gz\n`)

    const result = await verifyBinaryMetadata(s3, 'bucket', 'cmake.org', {
      repair: true,
      requireCleanScanAfter: Number.NEGATIVE_INFINITY,
    })

    expect(result.ok).toBe(false)
    expect(result.errors).toContain(
      'Missing digest-bound clean malware scan: cmake.org@3.24.2 darwin-arm64',
    )
  })

  it('refuses to replace metadata with an empty object listing for active binary domains', async () => {
    const s3 = new FakeS3()
    s3.put('binaries/cmake.org/3.24.2/darwin-arm64/cmake.org-3.24.2.tar.gz', 'tarball', 123)
    s3.put('binaries/cmake.org/3.24.2/darwin-arm64/cmake.org-3.24.2.tar.gz.sha256', `${'e'.repeat(64)}  cmake.org-3.24.2.tar.gz\n`)
    s3.put('binaries/cmake.org/metadata.json', JSON.stringify({
      name: 'cmake.org',
      latestVersion: '3.24.2',
      versions: {
        '3.24.2': {
          platforms: {
            'darwin-arm64': {
              tarball: 'binaries/cmake.org/3.24.2/darwin-arm64/cmake.org-3.24.2.tar.gz',
              sha256: 'e'.repeat(64),
              size: 123,
              uploadedAt: '2026-05-04T00:00:00.000Z',
            },
          },
        },
      },
      updatedAt: '2026-05-04T00:00:00.000Z',
    }))
    s3.listObjects = async () => ({ objects: [{ Key: 'binaries/cmake.org/metadata.json', Size: 1, LastModified: '2026-05-04T00:00:00.000Z' }] })

    const result = await verifyBinaryMetadata(s3, 'bucket', 'cmake.org', {
      repair: true,
    })

    expect(result.ok).toBe(true)
    expect(result.warnings).toContain('S3 object listing returned no tarballs; verified existing metadata without rebuilding')

    const metadata = JSON.parse(await s3.getObject('bucket', 'binaries/cmake.org/metadata.json'))
    expect(metadata.latestVersion).toBe('3.24.2')
  })
})
