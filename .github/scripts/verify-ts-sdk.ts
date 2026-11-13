import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '../..')
// Child commands change cwd; retain absolute consumer/compiler paths even
// when the caller selects a relative evidence directory.
const evidenceBase = resolve(process.env.PANTRY_SDK_EVIDENCE ?? tmpdir())
await mkdir(evidenceBase, { recursive: true })
const directory = await mkdtemp(join(evidenceBase, 'pantry-sdk-'))
const archive = process.argv[2] ? resolve(process.argv[2]) : join(directory, 'package.tgz')
const consumer = join(directory, 'consumer')
const commands: Array<{ phase: string, args: string[], code: number, log: string, diagnostics: number[] }> = []
const receipt = {
  directory,
  archive,
  input: process.argv[2] ? 'supplied archive; registry transport qualification is separate' : 'normally packed source candidate',
  compilerVersion: '7.1.0-dev.20261011.1',
  bunTypesVersion: '1.4.4',
  commands,
  installations: [] as Array<{ phase: string, lockSHA256: string, verifiedPayloadFiles: number }>,
  completed: false,
}
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function run(phase: string, args: string[], cwd = consumer): Promise<{ code: number, output: string }> {
  const child = Bun.spawn(args, { cwd, stdout: 'pipe', stderr: 'pipe', timeout: 120_000 })
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  const output = stdout + stderr
  const log = `${commands.length}-${phase}.log`
  await writeFile(join(directory, log), output)
  commands.push({ phase, args, code, log, diagnostics: [...output.matchAll(/error TS(\d+)/g)].map(match => Number(match[1])) })
  return { code, output }
}

const positive = `import { fetchPantryPackage, programsForPlatform, type PackageDomain, type PkgxPackage } from 'ts-pantry'
import { createPackageCatalogSearch, type PackageCatalogEntry } from 'ts-pantry/catalog'
const programs: string[] = programsForPlatform({ programs: ['common'], platformPrograms: { linux: ['native'] } }, 'linux-x86-64', '3.0')
programs.push('another')
const entries: PackageCatalogEntry[] = createPackageCatalogSearch([])('git', { kind: 'cli', limit: 5 })
entries.map(entry => entry.domain)
type IsAny<T> = 0 extends (1 & T) ? true : false
const functionIsPrecise: false = null as unknown as IsAny<typeof programsForPlatform>
const returnIsPrecise: false = null as unknown as IsAny<ReturnType<typeof programsForPlatform>>
const catalogIsPrecise: false = null as unknown as IsAny<typeof createPackageCatalogSearch>
const metadataIsPrecise: false = null as unknown as IsAny<Awaited<ReturnType<typeof fetchPantryPackage>>['packageInfo']>
async function metadata(): Promise<PkgxPackage> { return (await fetchPantryPackage('facebook.com/zstd')).packageInfo }
const knownDomain: PackageDomain = 'git-scm.org'
const domainIsNarrow: false = null as unknown as (string extends PackageDomain ? true : false)
export { functionIsPrecise, returnIsPrecise, catalogIsPrecise, metadataIsPrecise, metadata, knownDomain, domainIsNarrow }
`
const negative = `import { programsForPlatform } from 'ts-pantry'
const programs: number[] = programsForPlatform({ programs: ['common'], platformPrograms: { linux: ['native'] } }, 'linux-x86-64', '3.0')
export { programs }
`

try {
  assert(process.argv.length <= 3, 'Usage: bun .github/scripts/verify-ts-sdk.ts [archive.tgz]')
  if (!process.argv[2]) {
    const packed = await run('pack', [process.execPath, '--no-env-file', 'pm', 'pack', '--filename', archive], join(root, 'packages/ts-pantry'))
    assert(packed.code === 0, packed.output)
  }
  const archiveBytes = new Uint8Array(await readFile(archive))
  const files = await new Bun.Archive(archiveBytes).files()
  const manifest = await files.get('package/package.json')?.json() as { name?: string, version?: string } | undefined
  assert(manifest?.name === 'ts-pantry' && manifest.version, 'Expected a versioned ts-pantry package archive')
  const payload = new Map<string, string>()
  for (const [file, bytes] of files) {
    assert(file.startsWith('package/') && !file.split('/').includes('..'), `Unsafe archive path: ${file}`)
    payload.set(file.slice('package/'.length), hash(new Uint8Array(await bytes.arrayBuffer())))
  }
  Object.assign(receipt, { package: manifest.name, version: manifest.version, archiveSHA256: hash(archiveBytes), archiveFiles: payload.size })
  await mkdir(consumer)
  await writeFile(join(consumer, 'package.json'), JSON.stringify({
    name: 'strict-pantry-sdk-consumer', private: true, type: 'module',
    dependencies: { 'ts-pantry': `file:${archive}` },
    devDependencies: { typescript: receipt.compilerVersion, '@types/bun': receipt.bunTypesVersion },
  }))
  await writeFile(join(consumer, 'positive.ts'), positive)
  await writeFile(join(consumer, 'negative.ts'), negative)
  await writeFile(join(consumer, 'negative-metadata.ts'), `import { fetchPantryPackage } from 'ts-pantry'
const metadata = await fetchPantryPackage('facebook.com/zstd')
const programs: number[] = metadata.packageInfo.programs
export { programs }
`)
  await writeFile(join(consumer, 'negative-domain.ts'), `import type { PackageDomain } from 'ts-pantry'
const domain: PackageDomain = 'not-a-pantry-domain'
export { domain }
`)
  await writeFile(join(consumer, 'runtime.mjs'), `import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fetchPantryPackage, pantry, programsForPlatform, savePackageAsTypeScript } from 'ts-pantry'
const actual = programsForPlatform({ programs: ['common'], platformPrograms: { linux: ['native'] } }, 'linux-x86-64', '3.0')
if (JSON.stringify(actual) !== JSON.stringify(['common', 'native'])) throw new Error('Incorrect public platform programs')
console.log('platform programs: ok')
const metadata = await fetchPantryPackage('facebook.com/zstd')
assert.equal(metadata.fullDomainName, 'facebook.com/zstd')
assert.deepEqual(metadata.packageInfo, pantry.facebookcomzstd)
metadata.packageInfo.programs.push('not-in-the-shared-catalog')
assert.deepEqual((await fetchPantryPackage('zstd')).packageInfo, pantry.facebookcomzstd)
await assert.rejects(fetchPantryPackage('unknown.invalid/no-metadata'), /metadata/)
console.log('canonical independent metadata: ok')
const output = mkdtempSync(join(process.cwd(), 'metadata-export-'))
const cli = join(process.cwd(), 'node_modules/ts-pantry/dist/bin/cli.js')
const exported = spawnSync(process.execPath, [cli, 'fetch', 'zstd', '--json', '--no-cache', '--output-dir', output], { encoding: 'utf8', timeout: 5000 })
assert.equal(exported.status, 0, String(exported.error ?? exported.stderr))
assert.deepEqual(JSON.parse(readFileSync(join(output, 'facebook.com/zstd.json'), 'utf8')), pantry.facebookcomzstd)
console.log('installed canonical metadata CLI: ok')
for (const identity of [{ domain: 'metadata.example/nested', aliases: ['2way'] }, { domain: '42tools.example', aliases: [] }]) {
  const data = (await fetchPantryPackage('facebook.com/zstd')).packageInfo
  Object.assign(data, identity)
  const file = savePackageAsTypeScript(output, identity.domain, data)
  assert.deepEqual(Object.values(await import(pathToFileURL(file).href)), [data])
}
console.log('installed metadata TypeScript identifiers: ok')
`)
  let normalLock: string | undefined
  for (const frozen of [false, true]) {
    const phase = frozen ? 'frozen' : 'normal'
    if (frozen) await rm(join(consumer, 'node_modules'), { recursive: true, force: true })
    const installed = await run(`${phase}-install`, [process.execPath, '--no-env-file', 'install', ...(frozen ? ['--frozen-lockfile'] : [])])
    assert(installed.code === 0, installed.output)
    const lockSHA256 = hash(new Uint8Array(await readFile(join(consumer, 'bun.lock'))))
    if (frozen) assert(lockSHA256 === normalLock, 'Frozen install changed the consumer lock')
    else normalLock = lockSHA256
    const installedRoot = join(consumer, 'node_modules/ts-pantry')
    for (const [file, expected] of payload) {
      assert(hash(new Uint8Array(await readFile(join(installedRoot, file)))) === expected, `Installed package bytes differ: ${file}`)
    }
    receipt.installations.push({ phase, lockSHA256, verifiedPayloadFiles: payload.size })
    const compiler = join(consumer, 'node_modules/typescript/bin/tsc')
    const compilerManifest = JSON.parse(await readFile(join(consumer, 'node_modules/typescript/package.json'), 'utf8')) as { version?: string }
    assert(compilerManifest.version === receipt.compilerVersion, 'The maintained compiler version changed')
    for (const mode of ['NodeNext', 'Bundler']) {
      const compilerOptions = {
        strict: true, skipLibCheck: false, skipDefaultLibCheck: false, target: 'ESNext',
        module: mode === 'NodeNext' ? 'NodeNext' : 'ESNext', moduleResolution: mode, types: ['bun'], paths: {}, noEmit: true,
      }
      for (const name of ['positive', 'negative', 'negative-domain', 'negative-metadata']) {
        await writeFile(join(consumer, 'tsconfig.json'), JSON.stringify({ compilerOptions, files: [`${name}.ts`] }))
        const result = await run(`${phase}-${mode}-${name}`, [process.execPath, '--no-env-file', compiler, '--project', 'tsconfig.json', '--pretty', 'false'])
        if (name === 'positive') assert(result.code === 0, result.output)
        else {
          const diagnostics = [...result.output.matchAll(/error TS(\d+)/g)].map(match => Number(match[1]))
          const expectedLine = name === 'negative-metadata' ? 3 : 2
          assert(result.code !== 0 && diagnostics.length === 1 && diagnostics[0] === 2322 && result.output.includes(`${name}.ts(${expectedLine},`), result.output)
        }
      }
    }
    for (const runtime of [process.execPath, 'node']) {
      const result = await run(`${phase}-${runtime === process.execPath ? 'bun' : 'node'}-runtime`, [runtime, 'runtime.mjs'])
      assert(result.code === 0 && result.output.includes('platform programs: ok'), result.output)
    }
  }
  receipt.completed = true
}
catch (error) {
  Object.assign(receipt, { error: error instanceof Error ? error.message : String(error) })
  throw error
}
finally {
  await writeFile(join(directory, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`)
  console.log(`SDK evidence: ${directory}`)
  if (receipt.completed) await rm(join(consumer, 'node_modules'), { recursive: true, force: true })
}
