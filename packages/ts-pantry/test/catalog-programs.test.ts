import { expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { catalogPrograms, missingCatalogProgram } from '../scripts/catalog-programs'

function catalog(root: string, body: string): string {
  const directory = join(root, 'packages')
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'exampleorg.ts'), `export const exampleorgPackage = {\n  domain: 'example.org' as const,\n${body}\n}\n`)
  return directory
}

test('a vendor build that lacks a program the catalog declares is refused, whatever the recipe lists', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pantry-catalog-programs-'))
  try {
    const packages = catalog(root, `  programs: ['ls', 'chcon'] as const,`)
    const prefix = join(root, 'prefix')
    mkdirSync(join(prefix, 'bin'), { recursive: true })
    copyFileSync(process.execPath, join(prefix, 'bin', 'ls'))

    expect(await catalogPrograms('example.org', 'linux-x86-64', '9.10.0', packages)).toEqual(['ls', 'chcon'])
    expect(await missingCatalogProgram(prefix, 'example.org', 'linux-x86-64', '9.10.0', packages)).toContain('declared program chcon')

    copyFileSync(process.execPath, join(prefix, 'bin', 'chcon'))
    expect(await missingCatalogProgram(prefix, 'example.org', 'linux-x86-64', '9.10.0', packages)).toBeUndefined()
  }
  finally { rmSync(root, { recursive: true, force: true }) }
})

test('the catalog contract is the one a client on that platform and release enforces', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pantry-catalog-platforms-'))
  try {
    const packages = catalog(root, [
      `  programs: ['tool', 'legacy'] as const,`,
      `  platformPrograms: { darwin: ['keychain-helper'] },`,
      `  programVersions: { legacy: { before: 3 } },`,
    ].join('\n'))
    expect(await catalogPrograms('example.org', 'linux-x86-64', '3.1.0', packages)).toEqual(['tool'])
    expect(await catalogPrograms('example.org', 'darwin-arm64', '2.9.0', packages)).toEqual(['tool', 'legacy', 'keychain-helper'])

    const prefix = join(root, 'prefix')
    mkdirSync(join(prefix, 'bin'), { recursive: true })
    copyFileSync(process.execPath, join(prefix, 'bin', 'tool'))
    expect(await missingCatalogProgram(prefix, 'example.org', 'linux-x86-64', '3.1.0', packages)).toBeUndefined()
    expect(await missingCatalogProgram(prefix, 'example.org', 'darwin-arm64', '3.1.0', packages)).toContain('keychain-helper')
  }
  finally { rmSync(root, { recursive: true, force: true }) }
})

test('a domain with no catalog entry, or one that declares no programs, has nothing to refuse', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pantry-catalog-empty-'))
  try {
    const packages = catalog(root, `  programs: [] as const,`)
    const prefix = join(root, 'prefix')
    mkdirSync(prefix, { recursive: true })
    expect(await missingCatalogProgram(prefix, 'example.org', 'linux-x86-64', '1.0.0', packages)).toBeUndefined()
    expect(await missingCatalogProgram(prefix, 'unknown.example', 'linux-x86-64', '1.0.0', packages)).toBeUndefined()
  }
  finally { rmSync(root, { recursive: true, force: true }) }
})

test('coreutils requires chcon and runcon of a Linux artifact, which the vendor build of 9.10.0 lacks', async () => {
  const programs = await catalogPrograms('gnu.org/coreutils', 'linux-x86-64', '9.10.0')
  expect(programs).toContain('chcon')
  expect(programs).toContain('runcon')
})
