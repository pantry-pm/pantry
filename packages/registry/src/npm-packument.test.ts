import { describe, expect, it } from 'bun:test'
import type { PackageMetadata } from './types'
import { buildPackument, compareVersions, latestOf, mergeUpstream, npmDist, npmRegistryPath, packumentVersionOrTag } from './npm-packument'

function source(versions: Record<string, Partial<PackageMetadata> & Record<string, unknown>>) {
  return {
    listVersions: async () => Object.keys(versions),
    getPackageVersion: async (name: string, version: string) =>
      versions[version] ? { name, version, publishedAt: `2026-11-23T00:00:0${Object.keys(versions).indexOf(version)}.000Z`, ...versions[version] } as PackageMetadata : null,
  }
}

describe('npm packument', () => {
  it('turns the stored sha256 checksum into SRI integrity', () => {
    const hex = 'a'.repeat(64)
    expect(npmDist(`sha256:${hex}`)).toEqual({ integrity: `sha256-${Buffer.from(hex, 'hex').toString('base64')}` })
    expect(npmDist('sha1:ABCDEF')).toEqual({ shasum: 'abcdef' })
    expect(npmDist(undefined)).toEqual({})
    expect(npmDist('sha256:not-hex')).toEqual({})
  })

  it('orders versions by semver, releases above their prereleases', () => {
    expect(compareVersions('0.75.10', '0.75.9')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0', '1.0.0-beta.2')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0-beta.10', '1.0.0-beta.2')).toBeGreaterThan(0)
    expect(latestOf(['0.75.9', '0.75.10', '0.76.0-beta.1'])).toBe('0.75.10')
    expect(latestOf(['1.0.0-rc.1', '1.0.0-rc.2'])).toBe('1.0.0-rc.2')
  })

  it('reads npm and bun spellings of a scoped name, and rejects other paths', () => {
    expect(npmRegistryPath('/npm/@stacksjs%2fbuddy')).toEqual({ name: '@stacksjs/buddy' })
    expect(npmRegistryPath('/npm/@stacksjs%2Fbuddy')).toEqual({ name: '@stacksjs/buddy' })
    expect(npmRegistryPath('/npm/%40stacksjs%2fbuddy')).toEqual({ name: '@stacksjs/buddy' })
    expect(npmRegistryPath('/npm/@stacksjs/buddy')).toEqual({ name: '@stacksjs/buddy' })
    expect(npmRegistryPath('/npm/stacks')).toEqual({ name: 'stacks' })
    expect(npmRegistryPath('/npm/resolve/react@^16')).toBeNull()
    expect(npmRegistryPath('/npm/')).toBeNull()
    expect(npmRegistryPath('/npm/@stacksjs')).toBeNull()
  })

  it('serves every stored version with install fields and a Pantry tarball', async () => {
    const hex = 'b'.repeat(64)
    const packument = await buildPackument(source({
      '0.75.664': {
        description: 'Buddy',
        dependencies: { '@stacksjs/cli': '0.75.664' },
        bin: { buddy: './dist/cli.js' },
        scripts: { build: 'bun build.ts', postinstall: 'node setup.js' },
        devDependencies: { typescript: '^7' },
        checksum: `sha256:${hex}`,
      },
      '0.75.665': { dependencies: { '@stacksjs/cli': '0.75.665' }, checksum: `sha256:${hex}` },
    }), '@stacksjs/buddy', 'https://registry.pantry.dev') as any

    expect(packument['dist-tags']).toEqual({ latest: '0.75.665' })
    expect(Object.keys(packument.versions)).toEqual(['0.75.664', '0.75.665'])
    const first = packument.versions['0.75.664']
    expect(first.dist.tarball).toBe('https://registry.pantry.dev/packages/%40stacksjs%2Fbuddy/0.75.664/tarball')
    expect(first.dist.integrity).toStartWith('sha256-')
    expect(first.bin).toEqual({ buddy: './dist/cli.js' })
    expect(first.hasInstallScript).toBe(true)
    expect(first.devDependencies).toBeUndefined()
    expect(first.scripts).toBeUndefined()
    expect(packument.versions['0.75.665'].hasInstallScript).toBeUndefined()
    expect(packument.time['0.75.665']).toBeString()
  })

  it('answers null for a name Pantry holds nothing of, so npm can answer', async () => {
    expect(await buildPackument(source({}), 'left-pad', 'https://registry.pantry.dev')).toBeNull()
  })

  it('keeps versions only npm has, with Pantry winning a version both hold', async () => {
    const packument = await buildPackument(source({ '0.75.665': { checksum: `sha256:${'c'.repeat(64)}` } }), 'stacks', 'https://registry.pantry.dev') as any
    const merged = mergeUpstream(packument, {
      'dist-tags': { latest: '0.75.664', canary: '0.76.0-canary.1' },
      'versions': { '0.75.600': { version: '0.75.600' }, '0.75.665': { version: '0.75.665', dist: { tarball: 'https://registry.npmjs.org/x.tgz' } } },
      'time': { '0.75.600': '2026-10-01T00:00:00.000Z' },
    }) as any
    expect(Object.keys(merged.versions).sort()).toEqual(['0.75.600', '0.75.665'])
    expect(merged.versions['0.75.665'].dist.tarball).toStartWith('https://registry.pantry.dev/')
    expect(merged['dist-tags']).toEqual({ latest: '0.75.665', canary: '0.76.0-canary.1' })
    expect(merged.time['0.75.600']).toBe('2026-10-01T00:00:00.000Z')

    const npmAhead = mergeUpstream(packument, { 'dist-tags': { latest: '0.75.666' }, 'versions': { '0.75.666': {} } }) as any
    expect(npmAhead['dist-tags'].latest).toBe('0.75.666')
    expect(mergeUpstream(packument, null)).toBe(packument)
  })

  it('reads a version or dist-tag path the way npm serves /{name}/{version}', async () => {
    expect(npmRegistryPath('/npm/@stacksjs%2fbuddy/0.75.665')).toEqual({ name: '@stacksjs/buddy', version: '0.75.665' })
    expect(npmRegistryPath('/npm/stacks/latest')).toEqual({ name: 'stacks', version: 'latest' })
    expect(npmRegistryPath('/npm/stacks')).toEqual({ name: 'stacks' })
    expect(npmRegistryPath('/npm/stacks/1.0.0/tarball')).toBeNull()
    expect(npmRegistryPath('/npm/stacks/..%2f..')).toBeNull()
    const packument = await buildPackument(source({ '0.75.665': {} }), 'stacks', 'https://registry.pantry.dev') as any
    expect((packumentVersionOrTag(packument, 'latest') as any).version).toBe('0.75.665')
    expect((packumentVersionOrTag(packument, '0.75.665') as any).version).toBe('0.75.665')
    expect(packumentVersionOrTag(packument, '9.9.9')).toBeNull()
  })
})
