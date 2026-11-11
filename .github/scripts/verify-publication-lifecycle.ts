import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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

async function main(): Promise<void> {
  const binary = resolve(process.env.PANTRY_SOURCE_CLI || 'packages/zig/zig-out/bin/pantry')
  assert.ok(await Bun.file(binary).exists(), 'Build the checkout CLI before lifecycle acceptance')
  const fixture = await mkdtemp(join(tmpdir(), 'pantry-publish-lifecycle-'))
  const origin = `http://localhost:${await getAvailablePort()}`
  const registry = new Registry({ s3Bucket: 'local', dynamoTable: 'local', baseUrl: origin, npmFallback: false, localStoragePath: join(fixture, 'registry') })
  const storage = new InMemoryAuthStorage()
  const auth = new AuthService(storage)
  await auth.signup('publisher@lifecycle.test', 'Publisher', 'synthetic-password-123')
  await auth.setSubscription('publisher@lifecycle.test', { tier: 'team', status: 'active' })
  const token = (await auth.createApiToken('publisher@lifecycle.test', 'lifecycle', { permissions: ['publish'] })).token
  const server = createServer(registry, Number(new URL(origin).port), new InMemoryAnalytics(), new InMemoryZigStorage(), undefined, undefined, storage, new DevelopmentScanner())
  const commands: Array<Record<string, unknown>> = []
  const checks: string[] = []
  let completed = false

  async function cli(cwd: string, flags: string[]) {
    const child = Bun.spawn([binary, 'publish', '--registry', origin, ...flags], {
      cwd, env: { ...process.env, PANTRY_REGISTRY_TOKEN: token, PANTRY_TOKEN: '', BASE_URL: origin, NODE_ENV: 'test' },
      stdout: 'pipe', stderr: 'pipe', stdin: 'ignore', timeout: 60_000,
    })
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    const output = `${stdout}${stderr}`.replaceAll(token, '<fixture-token>')
    commands.push({ cwd, flags, code, output })
    return { code, output }
  }

  async function uploadedModule(name: string): Promise<string> {
    const response = await fetch(`${origin}/packages/${encodeURIComponent(name)}/1.0.0/tarball`)
    assert.equal(response.status, 200)
    const files = await new Bun.Archive(await response.arrayBuffer()).files()
    const file = files.get('package/dist/index.js')
    assert.ok(file, 'The real uploaded archive must contain the qualified module')
    return file.text()
  }

  async function packageFixture(label: string, scripts: string[], fails = false) {
    const directory = join(fixture, label)
    await mkdir(join(directory, 'dist'), { recursive: true })
    const name = `@fixture/lifecycle-${label}`
    const commands = Object.fromEntries(scripts.map(script => [script, `bun lifecycle.ts ${script}`]))
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name, version: '1.0.0', files: ['dist'], scripts: commands }))
    await writeFile(join(directory, 'dist/index.js'), 'export const value = "qualified";\n')
    await writeFile(join(directory, 'lifecycle.ts'), `await Bun.write('hook-marker', process.argv[2]);
  await Bun.write('dist/index.js', 'export const value = "rebuilt-' + process.argv[2] + '";\\n');
  ${fails ? 'process.exit(9)' : ''}`)
    return { directory, name }
  }

  server.start()
  try {
    for (const scripts of [['prepublishOnly', 'prepublish', 'build'], ['prepublish', 'build'], ['build']]) {
      const selected = scripts[0]!
      const normal = await packageFixture(`${selected}-default`, scripts)
      const published = await cli(normal.directory, [])
      assert.equal(published.code, 0, published.output)
      assert.equal(await readFile(join(normal.directory, 'hook-marker'), 'utf8'), selected)
      assert.equal(await uploadedModule(normal.name), `export const value = "rebuilt-${selected}";\n`)
      checks.push(`default lifecycle selects ${selected} and publishes its result`)

      const ignored = await packageFixture(`${selected}-ignored`, scripts)
      const before = await readFile(join(ignored.directory, 'dist/index.js'), 'utf8')
      const skipped = await cli(ignored.directory, ['--ignore-scripts'])
      assert.equal(skipped.code, 0, skipped.output)
      assert.equal(await Bun.file(join(ignored.directory, 'hook-marker')).exists(), false, `${selected} executed despite --ignore-scripts`)
      assert.equal(await readFile(join(ignored.directory, 'dist/index.js'), 'utf8'), before)
      assert.equal(await uploadedModule(ignored.name), before)
      checks.push(`ignore-scripts preserves ${selected} input bytes in the uploaded archive`)

      const record = structuredClone(await registry.getPublisherPackageRecord(ignored.name))
      const retry = await cli(ignored.directory, ['--ignore-scripts', '--verify-existing'])
      assert.equal(retry.code, 0, retry.output)
      assert.match(retry.output, /"action":"verified-existing"/)
      assert.equal(await Bun.file(join(ignored.directory, 'hook-marker')).exists(), false)
      assert.deepEqual(await registry.getPublisherPackageRecord(ignored.name), record)
      assert.equal(await uploadedModule(ignored.name), before)
      checks.push(`verify-existing skips ${selected} and preserves the immutable publication`)
    }

    const failing = await packageFixture('failure-default', ['prepublishOnly', 'build'], true)
    const failure = await cli(failing.directory, [])
    assert.notEqual(failure.code, 0, failure.output)
    assert.match(failure.output, /prepublishOnly script failed/)
    assert.equal(await registry.getPublisherPackageRecord(failing.name), null)
    checks.push('a failing default lifecycle cannot publish')

    const ignoredFailure = await packageFixture('failure-ignored', ['prepublishOnly', 'build'], true)
    const ignored = await cli(ignoredFailure.directory, ['--ignore-scripts'])
    assert.equal(ignored.code, 0, ignored.output)
    assert.equal(await Bun.file(join(ignoredFailure.directory, 'hook-marker')).exists(), false)
    assert.equal(await uploadedModule(ignoredFailure.name), 'export const value = "qualified";\n')
    checks.push('ignore-scripts skips failing hooks and publishes the existing payload')

    const dry = await packageFixture('dry-run', ['prepublishOnly', 'build'], true)
    for (const flags of [['--dry-run'], ['--dry-run', '--ignore-scripts']]) {
      const result = await cli(dry.directory, flags)
      assert.equal(result.code, 0, result.output)
      assert.equal(await Bun.file(join(dry.directory, 'hook-marker')).exists(), false)
      assert.equal(await registry.getPublisherPackageRecord(dry.name), null)
    }
    checks.push('dry-run never executes hooks or publishes')
    completed = true
  }
  finally {
    await server.stop(true)
    if (registry.metadata instanceof FileMetadataStorage) await registry.metadata.flush()
    const receipt = { completed, checks, commands, binary, binarySha256: new Bun.CryptoHasher('sha256').update(await Bun.file(binary).arrayBuffer()).digest('hex'), scope: 'Real native CLI and isolated HTTP registry; synthetic publisher and development scanner only' }
    if (process.env.PANTRY_LIFECYCLE_RECEIPT) await writeFile(process.env.PANTRY_LIFECYCLE_RECEIPT, JSON.stringify(receipt, null, 2))
    process.stdout.write(`${JSON.stringify({ ...receipt, commands: commands.map(command => ({ cwd: command.cwd, flags: command.flags, code: command.code })) })}\n`)
    await rm(fixture, { recursive: true, force: true })
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
})
