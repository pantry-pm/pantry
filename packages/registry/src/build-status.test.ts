import { describe, expect, it } from 'bun:test'
import { BuildStatusStore } from './storage/build-status'

function mockBucket() {
  const objects = new Map<string, Buffer>()
  let listCalls = 0
  const client = {
    async getObjectBuffer(_bucket: string, key: string): Promise<Buffer> {
      const value = objects.get(key)
      if (!value) throw new Error('S3 GET failed: 404 Not Found')
      return value
    },
    async putObject(input: { key: string, body: Buffer | string }): Promise<void> {
      objects.set(input.key, Buffer.isBuffer(input.body) ? input.body : Buffer.from(input.body))
    },
    async list(): Promise<Array<{ Key: string, LastModified: string }>> {
      listCalls++
      return [
        {
          Key: 'binaries/bun.sh/1.2.3/linux-arm64/bun.sh-1.2.3.tar.gz',
          LastModified: '2026-07-28T00:00:00.000Z',
        },
      ]
    },
  }
  return { client, objects, get listCalls() { return listCalls } }
}

describe('BuildStatusStore coverage persistence', () => {
  it('restores coverage without relisting the full binary namespace', async () => {
    const bucket = mockBucket()
    const first = new BuildStatusStore(bucket.client as any, 'pantry')
    await first.load()
    await first.refreshCoverage(true)
    expect(bucket.listCalls).toBe(1)
    expect(bucket.objects.has('build-status/coverage.json')).toBeTrue()

    const restarted = new BuildStatusStore(bucket.client as any, 'pantry')
    await restarted.load()
    await restarted.refreshCoverage()
    expect(bucket.listCalls).toBe(1)

    const result = await restarted.getPackages()
    const bun = result.packages.find(pkg => pkg.domain === 'bun.sh')
    expect(bun?.latestVersion).toBe('1.2.3')
    expect(bun?.platforms['linux-arm64']).toBeTrue()
  })

  it('merges newer successful build events into restored coverage', async () => {
    const bucket = mockBucket()
    const first = new BuildStatusStore(bucket.client as any, 'pantry')
    await first.load()
    await first.refreshCoverage(true)
    first.record({ domain: 'bun.sh', version: '1.2.4', platform: 'darwin-arm64', state: 'built' })
    await Bun.sleep(1_100)

    const restarted = new BuildStatusStore(bucket.client as any, 'pantry')
    await restarted.load()
    const result = await restarted.getPackages()
    const bun = result.packages.find(pkg => pkg.domain === 'bun.sh')
    expect(bun?.latestVersion).toBe('1.2.4')
    expect(bun?.platforms['darwin-arm64']).toBeTrue()
  })
})

describe('BuildStatusStore partial coverage', () => {
  /**
   * The craft-native.org shape: a release published for one platform and
   * neither darwin, while the catalog still knew only the previous version.
   * Every field a caller could have looked at said there was nothing to do.
   */
  function partiallyBuiltBucket() {
    const objects = new Map<string, Buffer>()
    const client = {
      async getObjectBuffer(_bucket: string, key: string): Promise<Buffer> {
        const value = objects.get(key)
        if (!value) throw new Error('S3 GET failed: 404 Not Found')
        return value
      },
      async putObject(input: { key: string, body: Buffer | string }): Promise<void> {
        objects.set(input.key, Buffer.isBuffer(input.body) ? input.body : Buffer.from(input.body))
      },
      async list(): Promise<Array<{ Key: string, LastModified: string }>> {
        return [
          {
            Key: 'binaries/craft-native.org/0.0.86/linux-x86-64/craft-native.org-0.0.86.tar.gz',
            LastModified: '2026-09-01T18:38:08.380Z',
          },
        ]
      },
    }
    return { client, objects }
  }

  async function partiallyBuiltStore() {
    const bucket = partiallyBuiltBucket()
    const store = new BuildStatusStore(bucket.client as any, 'pantry')
    await store.load()
    store.setSupportedPlatforms(new Map([
      ['craft-native.org', ['darwin-arm64', 'darwin-x86-64', 'linux-x86-64']],
    ]))
    // The catalog lags the release it just published.
    store.setKnownPackages(new Map([['craft-native.org', ['0.0.84', '0.0.85']]]))
    await store.refreshCoverage(true)
    const result = await store.getPackages()
    return result.packages.find(pkg => pkg.domain === 'craft-native.org')!
  }

  it('names the supported platforms the latest version is missing', async () => {
    const craft = await partiallyBuiltStore()

    expect(craft.latestVersion).toBe('0.0.86')
    expect(craft.platforms['linux-x86-64']).toBeTrue()
    expect(craft.platforms['darwin-arm64']).toBeFalse()
    expect(craft.missingPlatforms).toEqual(['darwin-arm64', 'darwin-x86-64'])
    expect(craft.incomplete).toBeTrue()
  })

  it('never reports a newestVersion below the version it has published', async () => {
    const craft = await partiallyBuiltStore()

    // The catalog's newest is 0.0.85; 0.0.86 is published, so 0.0.86 is the
    // newest version that exists. Reporting 0.0.85 here — as this did — is a
    // row that contradicts its own latestVersion.
    expect(craft.newestVersion).toBe('0.0.86')
    // Still no update to build: nothing newer than what has been published.
    expect(craft.hasUpdate).toBeFalse()
  })

  it('leaves a fully built package alone', async () => {
    const objects = new Map<string, Buffer>()
    const client = {
      async getObjectBuffer(_bucket: string, key: string): Promise<Buffer> {
        const value = objects.get(key)
        if (!value) throw new Error('S3 GET failed: 404 Not Found')
        return value
      },
      async putObject(input: { key: string, body: Buffer | string }): Promise<void> {
        objects.set(input.key, Buffer.isBuffer(input.body) ? input.body : Buffer.from(input.body))
      },
      async list(): Promise<Array<{ Key: string, LastModified: string }>> {
        return [
          { Key: 'binaries/bun.sh/1.2.3/linux-x86-64/bun.sh-1.2.3.tar.gz', LastModified: '2026-07-28T00:00:00.000Z' },
          { Key: 'binaries/bun.sh/1.2.3/darwin-arm64/bun.sh-1.2.3.tar.gz', LastModified: '2026-07-28T00:00:00.000Z' },
        ]
      },
    }
    const store = new BuildStatusStore(client as any, 'pantry')
    await store.load()
    store.setSupportedPlatforms(new Map([['bun.sh', ['darwin-arm64', 'linux-x86-64']]]))
    await store.refreshCoverage(true)
    const result = await store.getPackages()
    const bun = result.packages.find(pkg => pkg.domain === 'bun.sh')

    expect(bun?.missingPlatforms).toEqual([])
    expect(bun?.incomplete).toBeFalse()
  })

  it('does not call an unbuilt catalog entry incomplete', async () => {
    const bucket = partiallyBuiltBucket()
    const store = new BuildStatusStore(bucket.client as any, 'pantry')
    await store.load()
    // Known to the catalog, nothing published. `published: false` already says
    // this; reporting four missing platforms would bury the half-built rows.
    store.setKnownPackages(new Map([['zig.dev', ['0.15.0']]]))
    await store.refreshCoverage(true)
    const result = await store.getPackages()
    const zig = result.packages.find(pkg => pkg.domain === 'zig.dev')

    expect(zig?.published).toBeFalse()
    expect(zig?.missingPlatforms).toEqual([])
    expect(zig?.incomplete).toBeFalse()
  })

  it('still flags a genuinely newer catalog version as an update', async () => {
    const bucket = partiallyBuiltBucket()
    const store = new BuildStatusStore(bucket.client as any, 'pantry')
    await store.load()
    store.setKnownPackages(new Map([['craft-native.org', ['0.0.87']]]))
    await store.refreshCoverage(true)
    const result = await store.getPackages()
    const craft = result.packages.find(pkg => pkg.domain === 'craft-native.org')

    expect(craft?.newestVersion).toBe('0.0.87')
    expect(craft?.hasUpdate).toBeTrue()
  })
})
