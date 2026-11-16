import { expect, test } from 'bun:test'
import { resolveBuildDependencyGraph } from '../scripts/build-package'
import { loadRecipe } from '../scripts/recipe-loader'
import { recipe as gbm } from '../src/recipes/mesa3d.org/libgbm'

test('the native build shell preserves the explicit empty Mesa driver selections', () => {
  const setup = gbm.build!.script!.find(step => typeof step === 'string' && step.startsWith('meson setup')) as string
  const probe = Bun.spawnSync(['bash', '-c', `shopt -s nullglob; meson() { printf '%s\\0' "$@"; }; ${setup}`], { stdout: 'pipe', stderr: 'pipe' })
  expect(probe.exitCode, probe.stderr.toString()).toBe(0)
  const argv = probe.stdout.toString().split('\0')
  for (const option of ['platforms', 'gallium-drivers', 'vulkan-drivers', 'tools'])
    expect(argv).toContain(`-D${option}=[]`)
})

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
