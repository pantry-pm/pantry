import { expect, test } from 'bun:test'
import { resolveBuildDependencyGraph } from '../scripts/build-package'
import { loadRecipe } from '../scripts/recipe-loader'

test('the standalone GBM client runtime does not install Mesa renderer compilers', async () => {
  const graph = await resolveBuildDependencyGraph(new Map([['mesa3d.org/libgbm', 'mesa3d.org/libgbm']]), 'linux-x86-64', async domain => (await loadRecipe(domain, 'linux-x86-64')).recipe)
  expect(graph.has('dri.freedesktop.org')).toBe(true)
  expect(graph.has('mesa3d.org')).toBe(false)
  expect(graph.has('llvm.org')).toBe(false)
})

test('the GBM component requires an installed ABI check with inherited libraries removed', async () => {
  const { recipe } = await loadRecipe('mesa3d.org/libgbm', 'linux-x86-64', '26.0.6')
  expect(recipe.test?.required).toBe(true)
  expect(recipe.test?.script.join('\n')).toContain('gbm_format_get_name')
  expect(recipe.test?.script.join('\n')).toContain('env -u LD_LIBRARY_PATH')
})
