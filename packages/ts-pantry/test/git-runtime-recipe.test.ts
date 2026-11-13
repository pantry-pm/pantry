import { expect, test } from 'bun:test'
import { versionSatisfies } from '../scripts/build-package'
import { loadRecipe } from '../scripts/recipe-loader'
import { gitscmorgPackage } from '../src/packages/git-scmorg'

test('Git resolves the qualified portable Curl runtime', async () => {
  const loaded = await loadRecipe('git-scm.org', 'darwin-arm64', '2.56.1')
  const constraint = loaded.recipe.dependencies?.['curl.se'] as string
  expect(versionSatisfies('8.23.0.1', constraint)).toBe(false)
  expect(versionSatisfies('8.23.0.2', constraint)).toBe(true)
  expect(gitscmorgPackage.dependencies).toContain('curl.se^8.23.0.2')
})

test('Darwin Git owns its GNU iconv input instead of discovering a host installation', async () => {
  const loaded = await loadRecipe('git-scm.org', 'darwin-arm64', '2.56.1')
  const constraint = loaded.recipe.dependencies?.darwin?.['gnu.org/libiconv'] as string
  expect(constraint).toBeString()
  expect(versionSatisfies('1.19.0.1', constraint)).toBe(false)
  expect(versionSatisfies('1.19.0.2', constraint)).toBe(true)
  expect(gitscmorgPackage.dependencies).toContain('darwin:gnu.org/libiconv^1.19.0.2')
})

test('the missing Darwin publication retains the real upstream Git version', async () => {
  for (const platform of ['darwin-arm64', 'linux-arm64', 'linux-x86-64']) {
    const loaded = await loadRecipe('git-scm.org', platform, '2.56.1')
    expect(loaded.upstreamVersion).toBe('2.56.1')
    expect(loaded.publicationVersion).toBe('2.56.1')
    expect(loaded.recipe.test?.required).toBe(true)
  }
  expect(gitscmorgPackage.versions[0]).toBe('2.56.1')
})
