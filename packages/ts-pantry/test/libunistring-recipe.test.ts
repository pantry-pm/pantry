import { expect, test } from 'bun:test'
import { loadRecipe } from '../scripts/recipe-loader'
import { gnuorglibunistringPackage } from '../src/packages/gnu.org/libunistring'
import { versionSatisfies } from '../scripts/build-package'

test('Darwin libunistring requires the owned libiconv packaging revision', async () => {
  const loaded = await loadRecipe('gnu.org/libunistring', 'darwin-arm64', '1.4.2')
  const constraint = loaded.recipe.dependencies?.darwin?.['gnu.org/libiconv'] as string
  expect(versionSatisfies('1.19.0', constraint)).toBe(false)
  expect(versionSatisfies('1.19.0.1', constraint)).toBe(true)
  expect(gnuorglibunistringPackage.dependencies).toContain('darwin:gnu.org/libiconv^1.19.0.1')
})

test('libunistring repairs its unrecorded bundled iconv through a new source identity', async () => {
  for (const platform of ['darwin-arm64', 'linux-arm64', 'linux-x86-64']) {
    const loaded = await loadRecipe('gnu.org/libunistring', platform, '1.4.2.1')
    expect(loaded.upstreamVersion).toBe('1.4.2')
    expect(loaded.publicationVersion).toBe('1.4.2.1')
    expect(loaded.requiresRecipeBuild).toBe(true)
    expect(loaded.recipe.test?.required).toBe(true)
  }
  expect(gnuorglibunistringPackage.versions[0]).toBe('1.4.2.1')
})
