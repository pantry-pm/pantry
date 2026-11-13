import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildRecipeSource } from '../scripts/port-pkgx-recipe'
import { resolveRuntimeEnvironment } from '../scripts/runtime-environment'

test('porting a pkgx recipe retains its actual runtime contract in an executable recipe module', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pantry-runtime-recipe-'))
  try {
    const input = Bun.YAML.parse('provides:\n  - bin/swig\nruntime:\n  env:\n    SWIG_LIB: "${{prefix}}/lib"\nbuild:\n  script: make install\n')
    const file = join(directory, 'recipe.ts')
    await writeFile(file, buildRecipeSource('swig.org', input))
    const { recipe } = await import(pathToFileURL(file).href)
    expect(recipe.runtime?.env).toEqual({ SWIG_LIB: '${{prefix}}/lib' })
    expect(resolveRuntimeEnvironment(recipe.runtime.env, directory)).toEqual({ SWIG_LIB: `${directory}/lib` })
    expect(recipe.programs).toEqual(['swig'])
    expect(recipe.build.script).toEqual(['make install'])
  }
  finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a recipe port rejects malformed runtime variables instead of dropping their contract', () => {
  expect(() => buildRecipeSource('tool.org', { runtime: { env: { 'BAD-NAME': 'value' } }, build: 'make install' })).toThrow('Invalid package runtime variable')
})
