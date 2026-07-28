import { afterEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { mirrorReleaseToS3, presignS3Url, releaseContentType, releaseObjectKey, releasePublicUrl } from './release-s3'
import type { ReleaseManifest } from './release-manifest'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true })
})

describe('S3 release mirroring', () => {
  test('builds deterministic provider-neutral keys and URLs', () => {
    expect(releaseObjectKey('/releases/acme/app/', '/v1.0.0/', '../app.pkg')).toBe('releases/acme/app/v1.0.0/app.pkg')
    expect(releasePublicUrl('https://cdn.example.test/', 'releases/acme app/v1/app.pkg')).toBe('https://cdn.example.test/releases/acme%20app/v1/app.pkg')
    expect(releaseContentType('App.pkg')).toBe('application/vnd.apple.installer+xml')
  })

  test('presigns virtual-hosted Hetzner and path-style endpoints', () => {
    const config = {
      provider: 'hetzner' as const,
      bucket: 'releases',
      region: 'fsn1',
      endpoint: '',
      prefix: '',
      publicUrl: '',
      forcePathStyle: false,
      cacheControl: '',
      accessKeyId: 'access',
      secretAccessKey: 'secret',
      sessionToken: '',
      dryRun: false,
    }
    expect(presignS3Url(config, 'apps/App 1.pkg', 'putObject', new Date('2026-07-28T00:00:00.000Z')))
      .toStartWith('https://releases.fsn1.your-objectstorage.com/apps/App%201.pkg?')
    expect(presignS3Url({ ...config, endpoint: 'https://objects.example.test/', forcePathStyle: true }, 'app.pkg', 'getObject'))
      .toStartWith('https://objects.example.test/releases/app.pkg?')
  })

  test('uploads artifacts, metadata, notes, and latest pointer', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pantry-release-s3-test-'))
    directories.push(directory)
    const artifact = path.join(directory, 'app.pkg')
    const manifestFile = path.join(directory, 'release-manifest.json')
    fs.writeFileSync(artifact, 'package')
    fs.writeFileSync(manifestFile, '{}\n')
    const manifest: ReleaseManifest = {
      schemaVersion: 1,
      repository: 'acme/app',
      tag: 'v1.0.0',
      commit: 'abc',
      generatedAt: '2026-07-28T00:00:00.000Z',
      assets: [{ name: 'app.pkg', size: 7, sha256: 'hash' }],
    }
    const uploads: string[] = []

    const receipt = await mirrorReleaseToS3({
      config: {
        provider: 'hetzner',
        bucket: 'releases',
        region: 'fsn1',
        endpoint: 'fsn1.your-objectstorage.com',
        prefix: 'apps/acme',
        publicUrl: 'https://downloads.example.test',
        forcePathStyle: false,
        cacheControl: 'public, max-age=31536000, immutable',
        accessKeyId: 'id',
        secretAccessKey: 'secret',
        sessionToken: '',
        dryRun: false,
      },
      manifest,
      manifestFile,
      releaseNotes: 'Changes',
      files: [artifact],
    }, {
      presign: (_config, key) => `https://upload.example.test/${key}`,
      async upload(file, url) {
        const key = new URL(url).pathname.slice(1)
        receiptPlaceholder.set(key, fs.statSync(file).size)
        uploads.push(key)
      },
      async headSize(url) {
        return receiptPlaceholder.get(new URL(url).pathname.slice(1))
      },
    })

    expect(uploads).toEqual([
      'apps/acme/v1.0.0/app.pkg',
      'apps/acme/v1.0.0/release-manifest.json',
      'apps/acme/v1.0.0/CHANGELOG.md',
      'apps/acme/latest.json',
    ])
    expect(receipt.objects[0]).toMatchObject({
      name: 'app.pkg',
      contentType: 'application/vnd.apple.installer+xml',
      url: 'https://downloads.example.test/apps/acme/v1.0.0/app.pkg',
    })
    expect(receipt.objects[0].sha256).toHaveLength(64)
    expect(receipt.objects.at(-1)).toMatchObject({
      name: 'latest.json',
      cacheControl: 'no-cache',
    })
  })

  test('plans without constructing a client', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pantry-release-s3-dry-run-'))
    directories.push(directory)
    const artifact = path.join(directory, 'app.zip')
    const manifestFile = path.join(directory, 'release-manifest.json')
    fs.writeFileSync(artifact, 'zip')
    fs.writeFileSync(manifestFile, '{}\n')
    let constructed = false

    const receipt = await mirrorReleaseToS3({
      config: {
        provider: 'aws',
        bucket: 'bucket',
        region: 'us-east-1',
        endpoint: '',
        prefix: '',
        publicUrl: '',
        forcePathStyle: false,
        cacheControl: '',
        accessKeyId: 'id',
        secretAccessKey: 'secret',
        sessionToken: '',
        dryRun: true,
      },
      manifest: {
        schemaVersion: 1,
        repository: 'acme/app',
        tag: 'v1',
        commit: '',
        generatedAt: '2026-07-28T00:00:00.000Z',
        assets: [],
      },
      manifestFile,
      releaseNotes: '',
      files: [artifact],
    }, {
      presign: () => {
        constructed = true
        throw new Error('not expected')
      },
    })

    expect(constructed).toBeFalse()
    expect(receipt.dryRun).toBeTrue()
  })
})

const receiptPlaceholder = new Map<string, number>()
