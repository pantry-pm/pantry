import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { pack } from 'tar-stream'
import { AuthService, InMemoryAuthStorage } from './auth'
import { DevelopmentScanner } from './malware-scanning'
import { Registry } from './registry'
import { createServer } from './server'
import { FileMetadataStorage } from './storage/metadata'
import { getAvailablePort } from './test-utils'

const NAME = '@fixture/immutable-kit'
const VERSION = '1.0.0'
const PRIVATE = { access: 'restricted' }

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

async function responseBody(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json()
  if (!isObject(value)) throw new Error('Registry response was not a JSON object')
  return value
}

async function archive(options: { revision?: string, mode?: number, link?: string, repack?: boolean, public?: boolean, wrapperMode?: number } = {}): Promise<Uint8Array<ArrayBuffer>> {
  const output = pack()
  if (options.wrapperMode !== undefined) output.entry({ name: 'package/', type: 'directory', mode: options.wrapperMode, mtime: new Date(0) })
  const entries = [
    { name: 'package/pantry.json', body: JSON.stringify({ name: NAME, version: VERSION, publishConfig: options.public ? { access: 'public' } : PRIVATE }) },
    { name: 'package/platform.json', body: JSON.stringify({ revision: options.revision || 'source-alpha' }) },
    { name: 'package/source/main.ts', body: 'export const answer = 42\n', mode: options.mode || 0o644 },
    { name: 'package/source/current.ts', linkname: options.link || 'main.ts' },
  ]
  for (const entry of options.repack ? entries.reverse() : entries) {
    output.entry({
      name: entry.name,
      type: 'linkname' in entry ? 'symlink' : 'file',
      ...('linkname' in entry ? { linkname: entry.linkname } : {}),
      mode: 'linkname' in entry ? 0o777 : (entry.mode || 0o644),
      mtime: new Date(options.repack ? 1_000_000 : 0),
      uid: options.repack ? 1001 : 501,
      gid: options.repack ? 1001 : 20,
    }, 'body' in entry ? entry.body : undefined)
  }
  output.finalize()
  const chunks: Buffer[] = []
  for await (const chunk of output) chunks.push(Buffer.from(chunk))
  return new Uint8Array(gzipSync(Buffer.concat(chunks), { level: options.repack ? 1 : 9 }))
}

describe('immutable publication verification over HTTP', () => {
  let directory: string
  let registry: Registry
  let server: ReturnType<typeof createServer>
  let auth: AuthService
  let origin: string
  let publisher: string
  let storage: InMemoryAuthStorage
  const saved = new Map<string, string | undefined>()
  const environment = ['PANTRY_REGISTRY_TOKEN', 'PANTRY_TOKEN', 'BASE_URL', 'REGISTRY_INTERNAL_URL', 'REGISTRY_VISIBILITY', 'STRIPE_SECRET_KEY']

  async function publish(bytes: Uint8Array<ArrayBuffer>, token = publisher, extra: Record<string, unknown> = {}, verify = true) {
    const body = new FormData()
    body.set('metadata', JSON.stringify({ name: NAME, version: VERSION, publishConfig: PRIVATE, ...extra }))
    body.set('tarball', new File([bytes], 'kit.tgz'))
    return fetch(`${origin}/publish`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, ...(verify ? { 'X-Pantry-Verify-Existing': 'true' } : {}) }, body })
  }

  beforeEach(async () => {
    for (const name of environment) {
      saved.set(name, process.env[name])
      delete process.env[name]
    }
    process.env.PANTRY_REGISTRY_TOKEN = 'publication-verification-fixture-admin'
    directory = await mkdtemp(join(tmpdir(), 'pantry-publication-verification-'))
    const port = await getAvailablePort()
    origin = `http://localhost:${port}`
    registry = new Registry({ s3Bucket: 'local', dynamoTable: 'local', baseUrl: origin, npmFallback: false, localStoragePath: directory })
    storage = new InMemoryAuthStorage()
    auth = new AuthService(storage)
    await auth.signup('publisher@publication.test', 'Publisher', 'synthetic-password-123')
    await auth.setSubscription('publisher@publication.test', { tier: 'team', status: 'active' })
    publisher = (await auth.createApiToken('publisher@publication.test', 'publish-only', { permissions: ['publish'] })).token
    server = createServer(registry, port, undefined, undefined, undefined, undefined, storage, new DevelopmentScanner())
    server.start()
  })

  afterEach(async () => {
    await server?.stop(true)
    if (registry?.metadata instanceof FileMetadataStorage) await registry.metadata.flush()
    if (directory) await rm(directory, { recursive: true, force: true })
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    saved.clear()
  })

  test('verifies an exact retry without changing the version or download counters', async () => {
    const bytes = await archive()
    expect((await publish(bytes)).status).toBe(201)
    const before = structuredClone(await registry.getPublisherPackageRecord(NAME))
    const response = await publish(bytes)
    expect(response.status).toBe(200)
    const body = await responseBody(response)
    expect(body.action).toBe('verified-existing')
    expect(body.verification).toBe('archive-sha256')
    expect(await registry.getPublisherPackageRecord(NAME)).toEqual(before)
    await registry.downloadTarball(NAME, VERSION)
    expect((await registry.getPublisherPackageRecord(NAME))?.totalDownloads).toBe(1)
  })

  test('preserves the conflict contract when verification was not requested', async () => {
    const bytes = await archive()
    expect((await publish(bytes)).status).toBe(201)
    expect((await publish(bytes, publisher, {}, false)).status).toBe(409)
  })

  test('verifies the complete payload across compression, order, owner and timestamp differences', async () => {
    const first = await archive()
    const repacked = await archive({ repack: true })
    expect(repacked).not.toEqual(first)
    expect((await publish(first)).status).toBe(201)
    const before = structuredClone(await registry.getPublisherPackageRecord(NAME))
    const response = await publish(repacked)
    expect(response.status).toBe(200)
    const body = await responseBody(response)
    expect(body.action).toBe('verified-existing')
    expect(body.verification).toBe('payload-sha256-v2')
    expect(body.visibility).toBe('private')
    expect(await registry.getPublisherPackageRecord(NAME)).toEqual(before)
  })

  test('verifies repacking across caller umasks without changing installed permissions', async () => {
    expect((await publish(await archive({ wrapperMode: 0o700 }))).status).toBe(201)
    const before = structuredClone(await registry.getPublisherPackageRecord(NAME))
    const response = await publish(await archive({ wrapperMode: 0o755 }))
    expect(response.status).toBe(200)
    expect((await responseBody(response)).verification).toBe('payload-sha256-v2')
    expect(await registry.getPublisherPackageRecord(NAME)).toEqual(before)
  })

  for (const [label, options] of [
    ['source revision', { revision: 'source-bravo' }],
    ['file permissions', { mode: 0o755 }],
    ['symlink target', { link: 'elsewhere.ts' }],
  ] as const) {
    test(`rejects a different ${label} without replacing the original`, async () => {
      expect((await publish(await archive())).status).toBe(201)
      const before = structuredClone(await registry.getPublisherPackageRecord(NAME))
      expect((await publish(await archive(options))).status).toBe(409)
      expect(await registry.getPublisherPackageRecord(NAME)).toEqual(before)
    })
  }

  test('keeps private reads hidden and rejects read-only and unrelated publishers', async () => {
    const bytes = await archive()
    expect((await publish(bytes)).status).toBe(201)
    const readOnly = (await auth.createApiToken('publisher@publication.test', 'read-only', { permissions: ['read'] })).token
    expect((await publish(bytes, readOnly)).status).toBe(401)
    await auth.signup('other@publication.test', 'Other', 'synthetic-password-123')
    const unrelated = (await auth.createApiToken('other@publication.test', 'publish-only', { permissions: ['publish'] })).token
    expect((await publish(bytes, unrelated)).status).toBe(403)
    expect((await publish(bytes)).status).toBe(200)
    for (const suffix of ['', '/1.0.0', '/1.0.0/tarball']) {
      expect((await fetch(`${origin}/packages/${encodeURIComponent(NAME)}${suffix}`)).status).toBe(404)
    }
  })

  test('verifies JSON uploads through the same identity checks', async () => {
    expect((await publish(await archive())).status).toBe(201)
    const before = structuredClone(await registry.getPublisherPackageRecord(NAME))
    const response = await fetch(`${origin}/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${publisher}`, 'X-Pantry-Verify-Existing': 'true' },
      body: JSON.stringify({ metadata: { name: NAME, version: VERSION, publishConfig: PRIVATE }, tarball: Buffer.from(await archive({ repack: true })).toString('base64') }),
    })
    expect(response.status).toBe(200)
    expect((await responseBody(response)).action).toBe('verified-existing')
    expect(await registry.getPublisherPackageRecord(NAME)).toEqual(before)
  })

  test('reports missing stored bytes instead of acknowledging an unavailable version', async () => {
    const bytes = await archive()
    expect((await publish(bytes)).status).toBe(201)
    const before = structuredClone(await registry.getPublisherPackageRecord(NAME))
    const keys = await registry.tarball.list('packages/pantry/')
    expect(keys.length).toBeGreaterThan(0)
    for (const key of keys) await registry.tarball.delete(key)
    const response = await publish(bytes)
    expect(response.status).toBe(503)
    expect((await responseBody(response)).code).toBe('PUBLICATION_VERIFICATION_UNAVAILABLE')
    expect(await registry.getPublisherPackageRecord(NAME)).toEqual(before)
  })

  test('does not acknowledge an untrusted scan attestation', async () => {
    const bytes = await archive()
    expect((await publish(bytes)).status).toBe(201)
    const record = await registry.getPublisherPackageRecord(NAME)
    const stored = record?.versions[VERSION]
    if (!stored?.malwareScan) throw new Error('Fixture lacks its clean scan')
    await registry.metadata.putVersion(NAME, VERSION, { ...stored, name: NAME, malwareScan: { ...stored.malwareScan, artifactSha256: 'a'.repeat(64) } })
    const before = structuredClone(await registry.getPublisherPackageRecord(NAME))
    expect((await publish(bytes)).status).toBe(409)
    expect(await registry.getPublisherPackageRecord(NAME)).toEqual(before)
  })

  test('does not claim an existing public artifact fulfilled a private publication', async () => {
    const bytes = await archive({ public: true })
    expect((await publish(bytes, publisher, { publishConfig: { access: 'public' } })).status).toBe(201)
    expect((await publish(bytes)).status).toBe(409)
    expect((await registry.getPublisherPackageRecord(NAME))?.settings?.visibility).not.toBe('private')
  })

  test('verifies a concurrent identical publication after the atomic version race', async () => {
    await server.stop(true)
    let arrivals = 0
    let release: () => void = () => {}
    const both = new Promise<void>(resolve => { release = resolve })
    const development = new DevelopmentScanner()
    const scanner = {
      enabled: true, required: true,
      async scan(bytes: ArrayBuffer) {
        if (++arrivals === 2) release()
        await both
        return development.scan(bytes)
      },
      async health() { return { enabled: true, required: true, ready: true, engine: 'fixture' } },
    }
    const port = Number(new URL(origin).port)
    server = createServer(registry, port, undefined, undefined, undefined, undefined, storage, scanner)
    server.start()
    const results = await Promise.all([publish(await archive()), publish(await archive({ repack: true }))])
    expect(results.map(response => response.status).sort()).toEqual([200, 201])
    const verified = results.find(response => response.status === 200)
    expect(verified).toBeDefined()
    if (!verified) throw new Error('The concurrent retry was not verified')
    expect((await responseBody(verified)).action).toBe('verified-existing')
    expect(await registry.metadata.listVersions(NAME)).toEqual([VERSION])
  })
})
