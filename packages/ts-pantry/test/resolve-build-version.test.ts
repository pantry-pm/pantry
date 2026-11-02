import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveBuildVersion } from '../scripts/resolve-build-version'
import { dynamodblocalPackage } from '../src/packages/aws.amazon.com/dynamodb-local'
import { craftPackage } from '../src/packages/craft-native.org'
import { postgresPackage } from '../src/packages/postgresqlorg'
import { xorgprotocolxcbPackage } from '../src/packages/x.org/protocol/xcb'

test('the native producer reads the real dotted Craft catalog filename', async () => {
  expect(await resolveBuildVersion('craft-native.org')).toBe(craftPackage.versions[0])
})

test('the native producer reads the real nested DynamoDB metadata', async () => {
  expect(await resolveBuildVersion('aws.amazon.com/dynamodb-local')).toBe(dynamodblocalPackage.versions[0])
  expect(await resolveBuildVersion('aws.amazon.com/dynamodb-local', '3.3.0')).toBe('3.3.0')
  expect(await resolveBuildVersion('postgresql.org', '17.11')).toBe('17.11')
  expect(await resolveBuildVersion('openjdk.org', '27.0.0.35')).toBe('27.0.0.35')
})

test('catalog resolution preserves legacy filenames and collision-resolved domain identity', async () => {
  expect(await resolveBuildVersion('postgresql.org')).toBe(postgresPackage.versions[0])
  expect(await resolveBuildVersion('x.org/protocol/xcb')).toBe(xorgprotocolxcbPackage.versions[0])
  await expect(resolveBuildVersion('craft')).rejects.toThrow('No generated version for craft; specify an exact version')
  await expect(resolveBuildVersion('pantry-resolver-unknown.example')).rejects.toThrow('No generated version for pantry-resolver-unknown.example; specify an exact version')
  expect(await resolveBuildVersion('pantry-resolver-unknown.example', '1.2.3+repair.1')).toBe('1.2.3+repair.1')
})

test('the workflow entrypoint writes the catalog version and rejects output injection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pantry-version-resolution-'))
  const output = join(directory, 'github-output')
  try {
    const run = async (version: string) => {
      const child = Bun.spawn([process.execPath, join(import.meta.dir, '../scripts/resolve-build-version.ts')], {
        env: { ...process.env, REQUESTED_PACKAGE: 'craft-native.org', REQUESTED_VERSION: version, GITHUB_OUTPUT: output },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      return { exitCode, stdout, stderr }
    }
    const resolved = await run('')
    expect(resolved.exitCode).toBe(0)
    expect(resolved.stdout.trim()).toBe(`Building craft-native.org version ${craftPackage.versions[0]}`)
    expect(resolved.stderr).toBe('')
    const expected = `version=${craftPackage.versions[0]}\n`
    expect(await readFile(output, 'utf8')).toBe(expected)
    const rejected = await run('1.2.3\nother=value')
    expect(rejected.exitCode).not.toBe(0)
    expect(rejected.stderr).toContain('Provide an exact package version')
    expect(await readFile(output, 'utf8')).toBe(expected)
  }
  finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('producer inputs cannot escape metadata paths or inject shell and output syntax', async () => {
  for (const domain of ['', '../outside', '/tmp/example', 'aws.amazon.com//local', 'example.org/..', 'example.org/$(id)'])
    await expect(resolveBuildVersion(domain, '3.3.0')).rejects.toThrow('canonical package domain')
  for (const version of ['3.3.0\nother=value', '$(id)', '../3.3.0', '3.3.0;id'])
    await expect(resolveBuildVersion('aws.amazon.com/dynamodb-local', version)).rejects.toThrow('exact package version')
})
