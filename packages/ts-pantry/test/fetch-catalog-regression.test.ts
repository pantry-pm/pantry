import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fetchPantryPackage, savePackageAsTypeScript } from '../src/fetch'
import { facebookcomzstdPackage } from '../src/packages/facebook.com/zstd'

test('catalog discovery preserves the complete authored nested package and returns an independent value', async () => {
  const result = await fetchPantryPackage('facebook.com/zstd')
  expect(result.fullDomainName).toBe('facebook.com/zstd')
  expect(Object.entries(result.packageInfo)).toEqual(Object.entries(facebookcomzstdPackage))
  result.packageInfo.programs.push('not-a-catalog-program')
  expect(Object.entries((await fetchPantryPackage('zstd')).packageInfo)).toEqual(Object.entries(facebookcomzstdPackage))
})

test('unsupported discovery rejects rather than inventing package metadata', async () => {
  await expect(fetchPantryPackage('unknown.invalid/no-metadata')).rejects.toThrow('metadata')
})

test('TypeScript metadata export preserves aliases, escaped strings and metadata keys', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pantry-metadata-serialization-'))
  try {
    const { packageInfo } = await fetchPantryPackage('facebook.com/zstd')
    packageInfo.name = 'example'
    packageInfo.description = 'Quoted "metadata" with \'apostrophes\', \\paths and\nnewlines'
    packageInfo.aliases = ['example', 'example++', 'example --help']
    packageInfo.programs = ['folder\\program', 'a"b', "c'd"]
    packageInfo.platformPrograms = { linux: ['platform\\program'] }
    packageInfo.programVersions = { 'program-with-dash': { since: 1 } }
    const file = savePackageAsTypeScript(root, packageInfo.domain, packageInfo)
    const generated = await import(pathToFileURL(file).href)
    expect(Object.values(generated)).toEqual([packageInfo])
  }
  finally { rmSync(root, { recursive: true, force: true }) }
})

const cli = resolve(import.meta.dir, '../bin/cli.ts')
const authored = readFileSync(resolve(import.meta.dir, '../src/packages/facebook.com/zstd.ts'), 'utf8')

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pantry-fetch-catalog-'))
  const output = join(root, 'requested output')
  const cache = join(root, 'requested cache')
  mkdirSync(join(output, 'facebook.com'), { recursive: true })
  mkdirSync(join(root, 'src/packages'), { recursive: true })
  writeFileSync(join(output, 'facebook.com/zstd.ts'), authored)
  writeFileSync(join(output, 'index.ts'), 'export const requestedIndex = true\n')
  writeFileSync(join(root, 'src/packages/index.ts'), 'export const outsideRequestedOutput = true\n')
  return { root, output, cache }
}

async function run(f: ReturnType<typeof fixture>, args: string[]) {
  const child = Bun.spawn([process.execPath, cli, 'fetch', ...args, '--output-dir', f.output, '--cache-dir', f.cache], {
    cwd: f.root,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  return { code, stdout, stderr }
}

function snapshot(root: string, prefix = ''): Record<string, string> {
  const files: Record<string, string> = {}
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const path = join(prefix, entry.name)
    if (entry.isDirectory()) Object.assign(files, snapshot(root, path))
    else files[path] = readFileSync(join(root, path), 'utf8')
  }
  return files
}

test('the real uncached CLI preserves canonical metadata and confines index generation to the requested output', async () => {
  const f = fixture()
  try {
    const result = await run(f, ['facebook.com/zstd', '--no-cache'])
    expect(result.code).toBe(0)
    const generated = await import(pathToFileURL(join(f.output, 'facebook.com/zstd.ts')).href)
    expect(generated.facebookcomzstdPackage).toEqual(facebookcomzstdPackage)
    expect(readFileSync(join(f.root, 'src/packages/index.ts'), 'utf8')).toBe('export const outsideRequestedOutput = true\n')
    expect(readFileSync(join(f.output, 'index.ts'), 'utf8')).toContain('facebookcomzstd')
  }
  finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('the real CLI rejects unsupported metadata before changing either a single or mixed requested catalog', async () => {
  for (const args of [
    ['unknown.invalid/no-metadata', '--no-cache'],
    ['--pkg', 'facebook.com/zstd,unknown.invalid/no-metadata', '--no-cache'],
  ]) {
    const f = fixture()
    try {
      const before = snapshot(f.root)
      const result = await run(f, args)
      const after = snapshot(f.root)
      expect({ code: result.code, files: after }).toEqual({ code: 1, files: before })
      expect(`${result.stdout}\n${result.stderr}`).toContain('metadata')
    }
    finally { rmSync(f.root, { recursive: true, force: true }) }
  }
})

test('the real CLI cannot let a legacy corrupted cache override the maintained package', async () => {
  const f = fixture()
  try {
    mkdirSync(f.cache)
    writeFileSync(join(f.cache, 'facebook.com-zstd.json'), JSON.stringify({
      ...facebookcomzstdPackage,
      domain: 'facebook.com',
      dependencies: [],
      fetchedAt: Date.now(),
    }))
    const result = await run(f, ['facebook.com/zstd'])
    expect(result.code).toBe(0)
    const generated = await import(pathToFileURL(join(f.output, 'facebook.com/zstd.ts')).href)
    expect(generated.facebookcomzstdPackage).toEqual(facebookcomzstdPackage)
    expect(readdirSync(f.output).sort()).toEqual(['facebook.com', 'index.ts'])
  }
  finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('JSON export resolves aliases without rewriting the TypeScript catalog or writing a disabled cache', async () => {
  const f = fixture()
  try {
    const result = await run(f, ['zstd', '--json', '--no-cache'])
    expect(result.code).toBe(0)
    expect(JSON.parse(readFileSync(join(f.output, 'facebook.com/zstd.json'), 'utf8'))).toEqual(facebookcomzstdPackage)
    expect(readFileSync(join(f.output, 'facebook.com/zstd.ts'), 'utf8')).toBe(authored)
    expect(readFileSync(join(f.output, 'index.ts'), 'utf8')).toBe('export const requestedIndex = true\n')
    expect(readFileSync(join(f.root, 'src/packages/index.ts'), 'utf8')).toBe('export const outsideRequestedOutput = true\n')
    expect(existsSync(f.cache)).toBe(false)
  }
  finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('a limited catalog export preserves packages outside the requested subset', async () => {
  const f = fixture()
  try {
    const result = await run(f, ['--all', '--limit', '1', '--no-cache'])
    expect(result.code).toBe(0)
    expect(readFileSync(join(f.output, 'facebook.com/zstd.ts'), 'utf8')).toBe(authored)
    expect(readFileSync(join(f.root, 'src/packages/index.ts'), 'utf8')).toBe('export const outsideRequestedOutput = true\n')
    expect(existsSync(f.cache)).toBe(false)
  }
  finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('machine-readable export reports each canonical package once', async () => {
  const f = fixture()
  try {
    const result = await run(f, ['--pkg', 'zstd,facebook.com/zstd', '--output-json', '--no-cache'])
    expect(result.code).toBe(0)
    const report = JSON.parse(result.stdout)
    expect(report.success).toBe(true)
    expect(report.totalProcessed).toBe(1)
    expect(report.allProcessedPackages).toEqual(['facebook.com/zstd'])
  }
  finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('a full JSON export preserves the existing TypeScript catalog and index', async () => {
  const f = fixture()
  try {
    writeFileSync(join(f.output, 'unrelated.ts'), 'export const keep = true\n')
    const result = await run(f, ['--all', '--json', '--no-cache'])
    expect(result.code).toBe(0)
    expect(JSON.parse(readFileSync(join(f.output, 'facebook.com/zstd.json'), 'utf8'))).toEqual(facebookcomzstdPackage)
    expect(readFileSync(join(f.output, 'unrelated.ts'), 'utf8')).toBe('export const keep = true\n')
    expect(readFileSync(join(f.output, 'facebook.com/zstd.ts'), 'utf8')).toBe(authored)
    expect(readFileSync(join(f.output, 'index.ts'), 'utf8')).toBe('export const requestedIndex = true\n')
    expect(existsSync(f.cache)).toBe(false)
  }
  finally { rmSync(f.root, { recursive: true, force: true }) }
})
