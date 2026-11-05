import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateZigDefinitions } from '../src/generate-zig'

test('recipe program interfaces reach both generated installer catalogs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pantry-interface-catalog-'))
  const packages = join(root, 'packages')
  const recipes = join(root, 'recipes')
  const output = join(root, 'generated.zig')
  mkdirSync(packages)
  mkdirSync(recipes)
  try {
    writeFileSync(join(packages, 'fixture.ts'), "export const fixturePackage = { name: 'fixture', domain: 'fixture.example', programs: ['library.sh'], versions: ['1.0.0'] }")
    writeFileSync(join(recipes, 'fixture.example.ts'), "export const recipe = { sourceablePrograms: ['library.sh'] }")
    await generateZigDefinitions(packages, output)
    expect(readFileSync(output, 'utf8').replace(/\s+/g, '')).toContain('.sourceable_programs=&[_][]constu8{"library.sh"},')
    const contracts = join(root, 'catalog/program-interfaces.json')
    const complete = readFileSync(contracts, 'utf8')
    expect(JSON.parse(complete)).toEqual({ 'fixture.example': ['library.sh'] })
    writeFileSync(join(packages, 'invalid.ts'), "export const invalidPackage = { name: 'invalid', domain: 'invalid.example', programs: ['library.sh'], versions: ['1.0.0'] }")
    writeFileSync(join(recipes, 'invalid.example.ts'), "export const recipe = { sourceablePrograms: ['../escape.sh'] }")
    await expect(generateZigDefinitions(packages, output)).rejects.toThrow('incomplete native catalog')
    expect(readFileSync(contracts, 'utf8')).toBe(complete)
  }
  finally { rmSync(root, { recursive: true, force: true }) }
})

test('native catalog reads regenerated module content and preserves the last complete output on errors', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pantry-native-catalog-'))
  const packages = join(root, 'packages')
  const output = join(root, 'generated.zig')
  mkdirSync(packages)
  const source = join(packages, 'fixture.ts')
  try {
    const module = (dependency: string) => `export const fixturePackage = { name: 'fixture', domain: 'fixture.example', description: 'Fixture', dependencies: ['${dependency}'], versions: ['1.0.0'] }\n`
    writeFileSync(source, module('first.example'))
    await generateZigDefinitions(packages, output)
    expect(readFileSync(output, 'utf8')).toContain('first.example')
    writeFileSync(source, module('second.example'))
    await generateZigDefinitions(packages, output)
    const complete = readFileSync(output, 'utf8')
    expect(complete).toContain('second.example')
    expect(complete).not.toContain('first.example')
    writeFileSync(source, 'export const fixturePackage = {}\n')
    await expect(generateZigDefinitions(packages, output)).rejects.toThrow('incomplete native catalog')
    expect(readFileSync(output, 'utf8')).toBe(complete)
  }
  finally { rmSync(root, { recursive: true, force: true }) }
})

test('native catalog retains desktop kinds for routing without CLI-only flags', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pantry-native-kind-'))
  const packages = join(root, 'packages')
  const output = join(root, 'generated.zig')
  mkdirSync(packages)
  try {
    writeFileSync(join(packages, 'app.ts'), "export const fixturePackage = { name: 'Launchpad', domain: 'github.com/stacksjs/launchpad', programs: [], versions: ['1.0.3'] }")
    writeFileSync(join(packages, 'cli.ts'), "export const fixturePackage = { name: 'Tool', domain: 'tool.example', programs: ['tool'], versions: ['1.0.0'] }")
    await generateZigDefinitions(packages, output)
    const source = readFileSync(output, 'utf8')
    expect(source).toContain('.kind = .app,')
    expect(source).toContain('.kind = .cli,')
    expect(source).toContain('pub const PackageKind = enum { app, cli, library, font };')
  }
  finally { rmSync(root, { recursive: true, force: true }) }
})
