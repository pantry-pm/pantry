import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { AuthService, InMemoryAuthStorage } from '../../packages/registry/src/auth'
import { InMemoryAnalytics } from '../../packages/registry/src/analytics'
import { DevelopmentScanner } from '../../packages/registry/src/malware-scanning'
import { Registry } from '../../packages/registry/src/registry'
import { createServer } from '../../packages/registry/src/server'
import { FileMetadataStorage } from '../../packages/registry/src/storage/metadata'
import { getAvailablePort } from '../../packages/registry/src/test-utils'
import { InMemoryZigStorage } from '../../packages/registry/src/zig'

const binary = resolve(process.env.PANTRY_SOURCE_CLI || 'packages/zig/zig-out/bin/pantry')
assert.ok(await Bun.file(binary).exists(), 'Build the checkout CLI before publication transport acceptance')
const fixture = await mkdtemp(join(tmpdir(), 'pantry-native-publication-'))
const source = join(fixture, 'source')
const port = await getAvailablePort()
const origin = `http://localhost:${port}`
const name = '@fixture/native-publication'
const version = '1.0.0'
const registry = new Registry({ s3Bucket: 'local', dynamoTable: 'local', baseUrl: origin, npmFallback: false, localStoragePath: join(fixture, 'registry') })
const storage = new InMemoryAuthStorage()
const auth = new AuthService(storage)
await auth.signup('publisher@publication.test', 'Publisher', 'synthetic-password-123')
await auth.setSubscription('publisher@publication.test', { tier: 'team', status: 'active' })
const publisher = (await auth.createApiToken('publisher@publication.test', 'publish-only', { permissions: ['publish'] })).token
const reader = (await auth.createApiToken('publisher@publication.test', 'read-only', { permissions: ['read'] })).token
const server = createServer(registry, port, new InMemoryAnalytics(), new InMemoryZigStorage(), undefined, undefined, storage, new DevelopmentScanner())

async function cli(args: string[], token = publisher) {
  const child = Bun.spawn([binary, ...args], {
    cwd: fixture,
    env: { ...process.env, PANTRY_REGISTRY_TOKEN: token, PANTRY_TOKEN: '', BASE_URL: origin, NODE_ENV: 'test' },
    stdout: 'pipe', stderr: 'pipe', stdin: 'ignore',
  })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  const output = `${stdout}${stderr}`.replaceAll(publisher, '<fixture-publisher-token>').replaceAll(reader, '<fixture-reader-token>')
  return { code, output }
}

const publish = ['publish', '--registry', origin]
const checks: string[] = []
server.start()
try {
  await mkdir(source)
  await writeFile(join(fixture, 'pantry.json'), JSON.stringify({ name, version, files: ['pantry.json', 'source'], publishConfig: { access: 'restricted' } }))
  await writeFile(join(source, 'main.ts'), 'export const answer = 42\n')
  await symlink('main.ts', join(source, 'current.ts'))
  const initial = await cli(publish)
  assert.equal(initial.code, 0, initial.output)
  const original = structuredClone(await registry.getPublisherPackageRecord(name))
  assert.equal(original?.settings?.visibility, 'private')
  checks.push('native private publication')

  const ordinary = await cli(publish)
  assert.notEqual(ordinary.code, 0, 'An ordinary duplicate must retain its conflict result')
  assert.match(ordinary.output, /409|Version .*already exists/)
  checks.push('ordinary duplicate remains a conflict')

  for (const changedTime of [false, true]) {
    if (changedTime) await utimes(join(source, 'main.ts'), new Date(0), new Date(0))
    const retry = await cli([...publish, '--verify-existing'])
    assert.equal(retry.code, 0, retry.output)
    assert.match(retry.output, /"action":"verified-existing"/)
    assert.equal(await registry.getPublisherPackageRecord(name).then(record => JSON.stringify(record)), JSON.stringify(original))
    checks.push(changedTime ? 'portable repack identity' : 'exact retry identity')
  }

  await writeFile(join(source, 'main.ts'), 'export const answer = 43\n')
  const changed = await cli([...publish, '--verify-existing'])
  assert.notEqual(changed.code, 0, changed.output)
  assert.match(changed.output, /different or unverifiable payload/)
  assert.deepEqual(await registry.getPublisherPackageRecord(name), original)
  checks.push('altered payload rejected without replacement')

  const denied = await cli([...publish, '--verify-existing'], reader)
  assert.notEqual(denied.code, 0, denied.output)
  assert.match(denied.output, /401/)
  checks.push('read-only credential cannot verify a publication')
  for (const suffix of ['', '/1.0.0', '/1.0.0/tarball']) assert.equal((await fetch(`${origin}/packages/${encodeURIComponent(name)}${suffix}`)).status, 404)
  checks.push('anonymous private metadata and artifact stay hidden')

  const npm = await cli(['publish', '--npm', '--verify-existing', '--dry-run'])
  assert.notEqual(npm.code, 0)
  assert.match(npm.output, /supported by the Pantry registry, not npm/)
  checks.push('unsupported registry combination is explicit')

  console.log(JSON.stringify({ passed: true, checks, binary, binarySha256: new Bun.CryptoHasher('sha256').update(await Bun.file(binary).arrayBuffer()).digest('hex'), scope: 'Native checkout CLI and real isolated HTTP registry; synthetic account and development scanner only' }))
}
finally {
  await server.stop(true)
  if (registry.metadata instanceof FileMetadataStorage) await registry.metadata.flush()
  await rm(fixture, { recursive: true, force: true })
}
