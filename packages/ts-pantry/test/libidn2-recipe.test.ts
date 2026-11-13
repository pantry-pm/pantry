import { expect, test } from 'bun:test'
import { loadRecipe } from '../scripts/recipe-loader'
import { recipeBuildVersion, recipeAllowsMirror } from '../scripts/package-revisions'
import { gnuorglibidn2Package as libidn2Package } from '../src/packages/gnu.org/libidn2'
import { versionSatisfies } from '../scripts/build-package'

test('libidn2 declares the Unicode library its published shared library and pkg-config file require', async () => {
  const loaded = await loadRecipe('gnu.org/libidn2', 'darwin-arm64', '2.3.8')
  const constraint = loaded.recipe.dependencies?.['gnu.org/libunistring'] as string
  expect(versionSatisfies('1.4.2', constraint)).toBe(false)
  expect(versionSatisfies('1.4.2.1', constraint)).toBe(false)
  expect(versionSatisfies('1.4.2.2', constraint)).toBe(true)
  expect(libidn2Package.dependencies).toContain('gnu.org/libunistring^1.4.2.2')
})

test('libidn2 repairs native runtime ownership under a new immutable identity', async () => {
  for (const platform of ['darwin-arm64', 'linux-arm64', 'linux-x86-64']) {
    const loaded = await loadRecipe('gnu.org/libidn2', platform, '2.3.8.2')
    expect(loaded.upstreamVersion).toBe('2.3.8')
    expect(loaded.publicationVersion).toBe('2.3.8.2')
    expect(loaded.requiresRecipeBuild).toBe(true)
    expect(recipeAllowsMirror('2.3.8.2', recipeBuildVersion('2.3.8.2', { '2.3.8': 2 }))).toBe(false)
    expect(loaded.recipe.distributable?.url).toContain('libidn2-{{ version.raw }}.tar.gz')
    expect(loaded.recipe.test?.required).toBe(true)
  }
  expect(libidn2Package.versions[0]).toBe('2.3.8.2')
  expect(libidn2Package.versions).toContain('2.3.8.1')
})
