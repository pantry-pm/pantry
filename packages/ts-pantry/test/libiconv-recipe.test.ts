import { expect, test } from 'bun:test'
import { loadRecipe } from '../scripts/recipe-loader'
import { gnuorglibiconvPackage } from '../src/packages/gnu.org/libiconv'

test('Darwin iconv declares the gettext runtime its published CLI needs', async () => {
  const loaded = await loadRecipe('gnu.org/libiconv', 'darwin-arm64', '1.19.0')
  expect(loaded.recipe.dependencies?.darwin?.['gnu.org/gettext']).toBe('*')
  expect(gnuorglibiconvPackage.dependencies).toContain('darwin:gnu.org/gettext')
})

test('libiconv runtime ownership uses a new immutable source build with required native consumers', async () => {
  for (const platform of ['darwin-arm64', 'linux-arm64', 'linux-x86-64']) {
    const loaded = await loadRecipe('gnu.org/libiconv', platform, '1.19.0.2')
    expect(loaded.upstreamVersion).toBe('1.19.0')
    expect(loaded.publicationVersion).toBe('1.19.0.2')
    expect(loaded.requiresRecipeBuild).toBe(true)
    expect(loaded.recipe.distributable?.url).toContain('libiconv-{{version.marketing}}.tar.gz')
    expect(loaded.recipe.test?.required).toBe(true)
  }
  expect(gnuorglibiconvPackage.versions[0]).toBe('1.19.0.2')
})
