import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Registry } from './registry'
import { DevelopmentScanner } from './malware-scanning'
import { PackageVersionExistsError } from './publication'
import { FileMetadataStorage } from './storage/metadata'
import { DynamoDBMetadataStorage } from './storage/dynamodb-metadata'
import { DynamoDBClient } from './storage/dynamodb-client'
import { createHandler } from './server'
import { InMemoryAnalytics } from './analytics'
import { InMemoryZigStorage } from './zig'

const fixtures: Array<{ root: string, registry: Registry }> = []
async function registry(): Promise<Registry> {
  const root = await mkdtemp(join(tmpdir(), 'pantry-immutable-'))
  const instance = new Registry({ s3Bucket: 'local', dynamoTable: 'local', baseUrl: 'https://registry.example', npmFallback: false, localStoragePath: root })
  fixtures.push({ root, registry: instance })
  return instance
}
async function publish(instance: Registry, name: string, text: string): Promise<void> {
  const bytes = new TextEncoder().encode(text).buffer
  await instance.publish({ name, version: '1.0.0', publishedAt: new Date().toISOString(), malwareScan: await new DevelopmentScanner().scan(bytes) }, bytes)
}
async function contents(instance: Registry, name: string): Promise<string> {
  return new TextDecoder().decode((await instance.downloadTarball(name, '1.0.0')) ?? undefined)
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await (fixture.registry.metadata as FileMetadataStorage).flush()
    await rm(fixture.root, { recursive: true, force: true })
  }
})

describe('immutable package publication', () => {
  test('reports the actual engine fallback policy to forge integrations', async () => {
    const instance = await registry()
    const handler = createHandler(instance, new InMemoryAnalytics(), new InMemoryZigStorage(), 'https://registry.example')
    const info = await handler(new Request('https://registry.example/api/registry-info'))
    expect((await info.json()).npmFallback).toBe(false)
  })
  test('HTTP races return one creation and one conflict, with the winning bytes still downloadable', async () => {
    const instance = await registry()
    const previous = process.env.PANTRY_REGISTRY_TOKEN
    process.env.PANTRY_REGISTRY_TOKEN = 'immutable-publication-test'
    let arrived = 0
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const development = new DevelopmentScanner()
    const scanner = {
      enabled: true, required: true,
      async scan(bytes: ArrayBuffer) {
        arrived += 1
        if (arrived === 2) release()
        await gate
        return development.scan(bytes)
      },
      async health() { return { enabled: true, required: true, ready: true, engine: 'test' } },
    }
    const handler = createHandler(instance, new InMemoryAnalytics(), new InMemoryZigStorage(), 'https://registry.example', undefined, undefined, undefined, undefined, scanner)
    try {
      const requests = ['first', 'second'].map((bytes) => {
        const form = new FormData()
        form.set('metadata', JSON.stringify({ name: 'racing-package', version: '1.0.0' }))
        form.set('tarball', new Blob([bytes]), 'package.tgz')
        return handler(new Request('https://registry.example/publish', { method: 'POST', headers: { Authorization: 'Bearer immutable-publication-test' }, body: form }))
      })
      const results = await Promise.all(requests)
      expect(results.map(result => result.status).sort()).toEqual([201, 409])
      expect(await contents(instance, 'racing-package')).toBe(results[0].status === 201 ? 'first' : 'second')
    }
    finally {
      if (previous === undefined) delete process.env.PANTRY_REGISTRY_TOKEN
      else process.env.PANTRY_REGISTRY_TOKEN = previous
    }
  })
  test('two racing publishers cannot replace the winning version or its bytes', async () => {
    const instance = await registry()
    const results = await Promise.allSettled([publish(instance, '@owner/library', 'first bytes'), publish(instance, '@owner/library', 'second bytes')])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult
    expect(rejected.reason).toBeInstanceOf(PackageVersionExistsError)
    const winner = results[0].status === 'fulfilled' ? 'first bytes' : 'second bytes'
    expect(await contents(instance, '@owner/library')).toBe(winner)
    await expect(publish(instance, '@owner/library', 'replacement')).rejects.toBeInstanceOf(PackageVersionExistsError)
    expect(await contents(instance, '@owner/library')).toBe(winner)
  })

  test('scopes that flatten to the same storage name retain independent artifacts', async () => {
    const instance = await registry()
    await Promise.all([publish(instance, '@a-b/c', 'package one'), publish(instance, '@a/b-c', 'package two'), publish(instance, 'a-b-c', 'unscoped package')])
    expect(await contents(instance, '@a-b/c')).toBe('package one')
    expect(await contents(instance, '@a/b-c')).toBe('package two')
    expect(await contents(instance, 'a-b-c')).toBe('unscoped package')
  })

  test('legacy artifacts remain readable only when their recorded checksum matches', async () => {
    const instance = await registry()
    const bytes = new TextEncoder().encode('legacy bytes').buffer
    const key = 'packages/pantry/owner-library/1.0.0/owner-library-1.0.0.tgz'
    const checksum = `sha256:${new Bun.CryptoHasher('sha256').update(bytes).digest('hex')}`
    await instance.tarball.upload(key, bytes)
    await instance.metadata.putVersion('@owner/library', '1.0.0', { name: '@owner/library', version: '1.0.0', publishedAt: new Date().toISOString(), checksum, tarballUrl: 'https://registry.example/packages/%40owner%2Flibrary/1.0.0/tarball' })
    expect(await contents(instance, '@owner/library')).toBe('legacy bytes')
    await instance.tarball.upload(key, new TextEncoder().encode('another package').buffer)
    expect(await instance.downloadTarball('@owner/library', '1.0.0')).toBeNull()
  })

  test('DynamoDB version insertion uses its atomic create condition', async () => {
    const store = new DynamoDBMetadataStorage('test', 'us-east-1')
    const rows = new Map<string, any>()
    const conditions: string[] = []
    ;(store as any).db = {
      async getItem({ Key }: any) { return { Item: rows.get(Key.SK.S) } },
      async putItem({ Item, ConditionExpression }: any) {
        if (Item.SK.S.startsWith('VERSION#')) conditions.push(ConditionExpression)
        if (ConditionExpression && rows.has(Item.SK.S)) throw Object.assign(new Error('exists'), { awsType: 'ConditionalCheckFailedException' })
        rows.set(Item.SK.S, Item)
      },
      async updateItem() {},
    }
    const metadata = { name: 'test', version: '1.0.0', publishedAt: new Date().toISOString(), checksum: 'first' }
    await store.putVersion('test', '1.0.0', metadata, { ifAbsent: true })
    await expect(store.putVersion('test', '1.0.0', { ...metadata, checksum: 'second' }, { ifAbsent: true })).rejects.toBeInstanceOf(PackageVersionExistsError)
    expect(conditions).toEqual(['attribute_not_exists(PK)', 'attribute_not_exists(PK)'])
    expect(DynamoDBClient.unmarshal(rows.get('VERSION#1.0.0')).checksum).toBe('first')
  })
})
