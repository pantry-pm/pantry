import { describe, expect, it } from 'bun:test'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadPackageVersions, loadSupportedPlatforms, mapPlatformTokens, packageCatalogFromSource } from './catalog'

const here = dirname(fileURLToPath(import.meta.url))
const packagesRoot = resolve(here, '../../ts-pantry/src/packages')
const recipesRoot = resolve(here, '../../ts-pantry/src/recipes')

describe('registry package catalog', () => {
  it('parses literal package metadata without evaluating the module', () => {
    expect(
      packageCatalogFromSource(`
        export const example = {
          domain: 'example.com' as const,
          versions: ['2.0.0', '1.0.0'] as const,
        }
      `),
    ).toEqual({ domain: 'example.com', versions: ['2.0.0', '1.0.0'] })
    expect(
      packageCatalogFromSource(`
        export const empty = {
          domain: 'empty.example' as const,
          versions: [] as const,
        }
      `),
    ).toEqual({ domain: 'empty.example', versions: [] })
  })

  it('matches every canonical package exported by ts-pantry', async () => {
    const parsed = loadPackageVersions(packagesRoot)
    const packageIndexUrl = new URL('../../ts-pantry/src/packages/index.ts', import.meta.url)
    const runtimeImport = (specifier: string) => import(specifier)
    const { pantry } = await runtimeImport(packageIndexUrl.href) as {
      pantry: Record<string, { domain: string, versions: string[] }>
    }
    const expected = new Map<string, Set<string>>(
      Object.values(pantry).map(pkg => [pkg.domain, new Set(pkg.versions)]),
    )

    expect(parsed.size).toBe(expected.size)
    for (const [domain, versions] of expected) expect(parsed.get(domain)).toEqual(versions)
  })

  it('loads constrained recipe platforms without evaluating recipes', () => {
    expect(mapPlatformTokens(['darwin', 'linux/aarch64'])).toEqual([
      'darwin-arm64',
      'darwin-x86-64',
      'linux-arm64',
    ])
    const platforms = loadSupportedPlatforms(recipesRoot)
    expect(platforms.size).toBeGreaterThan(100)
    expect([...platforms.values()].every(value => value.length > 0 && value.length < 4)).toBeTrue()
  })
})
