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
