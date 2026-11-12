import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { savePackageAsTypeScript } from '../src/fetch'
import { recipe } from '../src/recipes/zig-dtsx.stacksjs.org'
import { mergeRecipeVersions, nativeRecipePackage } from '../../../.github/scripts/register-native-ci-packages'

test('registering an older CI pin never downgrades or deletes a newer catalogued release', () => {
  expect(mergeRecipeVersions(['2.0.0', '1.0.0'], ['1.5.0', '1.0.0'])).toEqual(['2.0.0', '1.5.0', '1.0.0'])
  expect(mergeRecipeVersions([], ['262.1', '262'])).toEqual(['262.1', '262'])
  expect(mergeRecipeVersions(['155.0.8059.84'], ['155.0.8059.84.1'])).toEqual(['155.0.8059.84.1', '155.0.8059.84'])
  for (const input of [[], ['latest'], ['1.2.3;id'], ['../1.2.3']])
    expect(() => mergeRecipeVersions([], input)).toThrow('exact stable versions')
})

test('a native catalog entry stays byte-identical when re-registered from its serialized metadata', async () => {
  const output = mkdtempSync(join(tmpdir(), 'pantry-native-metadata-'))
  try {
    const domain = recipe.domain
    const file = savePackageAsTypeScript(output, domain, nativeRecipePackage(recipe, undefined, ['0.11.52']))
    const original = readFileSync(file, 'utf8')
    const serialized = Object.values(await import(pathToFileURL(file).href)).find(value => value && typeof value === 'object' && 'domain' in value)
    expect(serialized).toBeTruthy()
    savePackageAsTypeScript(output, domain, nativeRecipePackage(recipe, serialized as Parameters<typeof nativeRecipePackage>[1], ['0.11.52']))
    expect(readFileSync(file, 'utf8')).toBe(original)
  }
  finally { rmSync(output, { recursive: true, force: true }) }
})
