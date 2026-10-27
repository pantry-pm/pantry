import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateZigDefinitions } from '../src/generate-zig'

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
