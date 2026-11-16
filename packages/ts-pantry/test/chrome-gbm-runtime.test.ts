import { expect, test } from 'bun:test'
import { resolveBuildDependencyGraph } from '../scripts/build-package'
import { loadRecipe } from '../scripts/recipe-loader'
import { recipe as chrome } from '../src/recipes/google.com/chrome'

test('the real Chrome runtime closure provides GBM without installing renderer compilers', async () => {
  const graph = await resolveBuildDependencyGraph(new Map([[chrome.domain, chrome.domain]]), 'linux-x86-64', async (domain) => {
    return (await loadRecipe(domain, 'linux-x86-64')).recipe
  })
  expect(graph.has('llvm.org')).toBe(false)
  expect(graph.has('mesa3d.org/libgbm')).toBe(true)
  expect(graph.has('dri.freedesktop.org')).toBe(true)
  expect(graph.has('mesa3d.org')).toBe(false)
})
