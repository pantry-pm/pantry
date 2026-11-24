import { describe, expect, it } from 'bun:test'
import { gzipSync } from 'node:zlib'
import { pack } from 'tar-stream'
import { installManifestOf, packagedInstallManifest } from './install-manifest'
import { buildPackument } from './npm-packument'
import { createLocalRegistry } from './registry'

async function archive(files: Record<string, string>): Promise<ArrayBuffer> {
  const output = pack()
  for (const [name, body] of Object.entries(files)) output.entry({ name, mode: 0o644, mtime: new Date(0) }, body)
  output.finalize()
  const chunks: Buffer[] = []
  for await (const chunk of output) chunks.push(Buffer.from(chunk))
  return new Uint8Array(gzipSync(Buffer.concat(chunks))).buffer
}

const manifest = {
  name: '@stacksjs/buddy',
  version: '0.75.700',
  description: 'Buddy',
  dependencies: { '@stacksjs/cli': '0.75.700' },
  optionalDependencies: { fsevents: '^2' },
  bin: { buddy: './dist/cli.js' },
  engines: { bun: '>=1.3' },
  os: ['darwin', 'linux'],
  scripts: { build: 'bun build.ts', postinstall: 'node setup.js' },
  devDependencies: { typescript: '^7' },
}

describe('install manifest', () => {
  it('keeps what an installer reads and drops the rest', () => {
    expect(installManifestOf(manifest)).toEqual({
      dependencies: { '@stacksjs/cli': '0.75.700' },
      optionalDependencies: { fsevents: '^2' },
      bin: { buddy: './dist/cli.js' },
      engines: { bun: '>=1.3' },
      os: ['darwin', 'linux'],
      scripts: { postinstall: 'node setup.js' },
    })
    expect(installManifestOf({ name: 'x', scripts: { build: 'tsc' } })).toEqual({})
    expect(installManifestOf(null)).toEqual({})
  })

  it('reads the packed package.json of exactly that version', async () => {
    const tarball = await archive({ 'package/package.json': JSON.stringify(manifest), 'package/dist/cli.js': '' })
    expect(packagedInstallManifest(tarball, '@stacksjs/buddy', '0.75.700')!.dependencies).toEqual({ '@stacksjs/cli': '0.75.700' })
    expect(packagedInstallManifest(tarball, '@stacksjs/buddy', '0.75.701')).toBeNull()
    expect(packagedInstallManifest(tarball, 'other', '0.75.700')).toBeNull()
    expect(packagedInstallManifest(new ArrayBuffer(8), '@stacksjs/buddy', '0.75.700')).toBeNull()
  })

  it('records the packed fields at publish, even when the request metadata omits them', async () => {
    const registry = createLocalRegistry('http://localhost:4999')
    const tarball = await archive({ 'package/package.json': JSON.stringify(manifest) })
    await registry.publish({ name: manifest.name, version: manifest.version, description: 'Buddy', publishedAt: '' }, tarball)

    const stored = await registry.getStoredVersion(manifest.name, manifest.version)
    expect(stored!.dependencies).toEqual({ '@stacksjs/cli': '0.75.700' })
    expect((stored as any).integrity).toBe(`sha512-${new Bun.CryptoHasher('sha512').update(tarball).digest('base64')}`)
    expect((stored as any).bin).toEqual({ buddy: './dist/cli.js' })

    const packument = await buildPackument({
      listVersions: name => registry.metadata.listVersions(name),
      getPackageVersion: (name, version) => registry.getStoredVersion(name, version),
    }, manifest.name, 'http://localhost:4999') as any
    const served = packument.versions['0.75.700']
    expect(served.dependencies).toEqual({ '@stacksjs/cli': '0.75.700' })
    expect(served.bin).toEqual({ buddy: './dist/cli.js' })
    expect(served.hasInstallScript).toBe(true)
    expect(served.install).toBeUndefined()
  })

  it('fills in a version recorded before install fields were kept, once', async () => {
    const registry = createLocalRegistry('http://localhost:4999')
    const tarball = await archive({ 'package/package.json': JSON.stringify(manifest) })
    await registry.publish({ name: manifest.name, version: manifest.version, publishedAt: '' }, tarball)
    // What a version stored by an earlier registry looks like.
    const record = await registry.metadata.getPackage(manifest.name)
    delete record!.versions[manifest.version]!.install
    expect((await registry.metadata.getPackageVersion(manifest.name, manifest.version))!.dependencies).toBeUndefined()

    const filled = await registry.getStoredVersion(manifest.name, manifest.version)
    expect(filled!.dependencies).toEqual({ '@stacksjs/cli': '0.75.700' })
    // Stored, so the next read needs no tarball.
    expect((await registry.metadata.getPackageVersion(manifest.name, manifest.version))!.install!.bin).toEqual({ buddy: './dist/cli.js' })
    expect((await registry.getPackage(manifest.name, manifest.version))!.dependencies).toEqual({ '@stacksjs/cli': '0.75.700' })
  })

  it('shares a legacy Pantry source inspection and remembers that it has no install fields', async () => {
    const registry = createLocalRegistry('http://localhost:4999')
    const name = '@test/platform'
    const version = '1.0.42'
    const tarball = await archive({ 'platform.json': JSON.stringify({ name, version }), 'source/config.ts': 'export default {}' })
    await registry.publish({ name, version, publishedAt: '' }, tarball)
    const record = await registry.metadata.getPackage(name)
    delete record!.versions[version]!.install
    const download = registry.downloadTarball.bind(registry)
    let reads = 0
    registry.downloadTarball = async (...args) => {
      if (++reads === 1) return null
      return download(...args)
    }

    expect((await registry.getStoredVersion(name, version))!.install).toBeUndefined()
    const [first, second] = await Promise.all([registry.getStoredVersion(name, version), registry.getStoredVersion(name, version)])
    // No install fields, but the archive's integrity, which is what marks it inspected.
    const inspected = { integrity: `sha512-${new Bun.CryptoHasher('sha512').update(tarball).digest('base64')}` }
    expect(first!.install).toEqual(inspected)
    expect(second!.install).toEqual(inspected)
    expect((await registry.getStoredVersion(name, version))!.install).toEqual(inspected)
    expect(reads).toBe(2)
  })

  it('inspects artifacts published under the old public registry origin through storage', async () => {
    const registry = createLocalRegistry('https://pantry.dev')
    const tarball = await archive({ 'package/package.json': JSON.stringify(manifest) })
    await registry.publish({ name: manifest.name, version: manifest.version, publishedAt: '' }, tarball)
    const record = (await registry.metadata.getPackage(manifest.name))!.versions[manifest.version]!
    delete record.install
    record.tarballUrl = record.tarballUrl.replace('https://pantry.dev/', 'https://registry.pantry.dev/')
    const stored = await registry.getStoredVersion(manifest.name, manifest.version)
    expect(stored!.install?.dependencies).toEqual(manifest.dependencies)
    const downloaded = await registry.downloadTarball(manifest.name, manifest.version)
    expect(downloaded).toEqual(tarball)
  })
})
