import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const cli = resolve(process.argv[2]!)
const qualified = resolve(process.argv[3]!)
const evidence = process.env.PANTRY_DTSX_EVIDENCE ?? tmpdir()
await mkdir(evidence, { recursive: true })
const owned = await mkdtemp(join(evidence, 'pantry-public-dtsx-'))
const platform = `${process.platform}-${process.arch}`
assert(['darwin-arm64', 'linux-arm64', 'linux-x64'].includes(platform), `Unsupported Pantry DTSX platform: ${platform}`)
const proof = JSON.parse(await readFile(join(qualified, 'qualification.json'), 'utf8'))
assert.match(proof.tag, /^v\d+\.\d+\.\d+$/)
const version = proof.tag.slice(1)
const commands: Array<Record<string, unknown>> = []
const receipt: Record<string, unknown> = { owned, platform, version, qualifiedRelease: proof, commands, completed: false }
const hash = (bytes: Uint8Array): string => new Bun.CryptoHasher('sha256').update(bytes).digest('hex')
async function run(args: string[], cwd: string, success = true, env = process.env, input?: string) {
  const child = Bun.spawn(args, { cwd, env, stdin: input === undefined ? 'ignore' : new Blob([input]), stdout: 'pipe', stderr: 'pipe', timeout: 60_000 })
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  const output = stdout + stderr
  const log = `${commands.length}.log`
  await writeFile(join(owned, log), output)
  commands.push({ args, cwd, code, log })
  assert.equal(code === 0, success, output)
  assert.notEqual(code, null, output)
  return output
}

try {
  receipt.pantryCLI = { path: cli, sha256: hash(new Uint8Array(await readFile(cli))), version: (await run([cli, '--version'], owned)).trim() }
  const project = join(owned, 'native-only')
  await mkdir(project)
  await writeFile(join(project, 'deps.yaml'), `dependencies:\n  zig-dtsx.stacksjs.org: ${version}\n`)
  await run([cli, 'install'], project)
  const launcher = join(project, 'pantry/.bin/zig-dtsx')
  const binary = join(project, `pantry/zig-dtsx.stacksjs.org/v${version}/bin/zig-dtsx`)
  assert.equal((await stat(launcher)).mode & 0o777, 0o755)
  assert.equal((await stat(binary)).mode & 0o777, 0o755, 'The normally installed CLI must already be executable')
  assert.equal(existsSync(join(project, 'node_modules')), false, 'Native installation must not create a JavaScript dependency tree')
  const archive = join(qualified, `assets/zig-dtsx-${platform}.zip`)
  assert.equal(hash(new Uint8Array(await readFile(archive))), proof.digests[platform])
  const extracted = Bun.spawnSync(['unzip', '-p', archive, 'zig-dtsx'], { timeout: 5000 })
  assert.equal(extracted.exitCode, 0, extracted.stderr.toString())
  assert.equal(hash(new Uint8Array(await readFile(binary))), hash(extracted.stdout), 'The public native package must contain the original release executable')
  receipt.binarySHA256 = hash(extracted.stdout)
  receipt.launcher = { path: launcher, sha256: hash(new Uint8Array(await readFile(launcher))) }
  receipt.nativeRuntimeNpmDependencies = 0
  const lock = await readFile(join(project, 'pantry.lock'), 'utf8')
  await run([cli, 'install', '--frozen-lockfile'], project)
  assert.equal(await readFile(join(project, 'pantry.lock'), 'utf8'), lock)
  receipt.nativeLockSHA256 = hash(new TextEncoder().encode(lock))
  assert.equal(hash(new Uint8Array(await readFile(binary))), hash(extracted.stdout))
  const nativeEnvironment = { ...process.env, PATH: '/usr/bin:/bin' }
  const stdinOutput = await run([launcher], project, true, nativeEnvironment, 'export const answer = 42;\n')
  assert(stdinOutput.includes('export declare const answer: 42;'))

  const library = join(owned, 'library')
  const consumer = join(owned, 'consumer')
  await mkdir(join(library, 'src/nested'), { recursive: true })
  await mkdir(consumer)
  const source = 'export class Calculate { #hidden = () => ({ value: 2 }); value(): number { return this.#hidden().value } }\nexport function sum(first: number = 1, last: number): number { return first + last }\n'
  receipt.sourceSHA256 = hash(new TextEncoder().encode(source))
  await writeFile(join(library, 'src/nested/index.ts'), source)
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module', devDependencies: { typescript: '7.0.2' } }))
  await run([cli, 'install'], consumer)
  assert.equal(JSON.parse(await readFile(join(consumer, 'node_modules/typescript/package.json'), 'utf8')).version, '7.0.2')
  const compiler = join(consumer, 'node_modules/typescript/lib/tsc.js')
  const compilerOptions = { strict: true, skipLibCheck: false, paths: {}, types: [], target: 'ESNext', module: 'NodeNext', moduleResolution: 'NodeNext', noEmit: true }
  async function controls(specifier: string) {
    const header = `import { Calculate, sum } from '${specifier}';\n`
    await writeFile(join(consumer, 'positive.ts'), `${header}const value: number = new Calculate().value(); const result: number = sum(undefined, 2); type IsAny<T> = 0 extends (1 & T) ? true : false; const safe: false = null as unknown as IsAny<ReturnType<Calculate['value']>>;`)
    await writeFile(join(consumer, 'negative.ts'), `${header}new Calculate().hidden();\nconst wrong: string = sum(1, 2);\nsum(1, 'wrong');\n`)
    for (const negative of [false, true]) {
      await writeFile(join(consumer, 'tsconfig.json'), JSON.stringify({ compilerOptions, files: [negative ? 'negative.ts' : 'positive.ts'] }))
      const output = await run([process.execPath, '--no-env-file', compiler, '--project', 'tsconfig.json'], consumer, !negative)
      if (negative) assert.deepEqual(output.match(/error TS\d+/g), ['error TS2339', 'error TS2322', 'error TS2345'], output)
    }
  }
  await controls('../library/src/nested/index.js')
  // The native executable runs with system tools alone, without a Bun/Node
  // command on PATH. The compiler above is an independent verification tool.
  await run([launcher, '--project', 'src', '--outdir', 'dist'], library, true, nativeEnvironment)
  const emitted = await readFile(join(library, 'dist/nested/index.d.ts'), 'utf8')
  receipt.declarationSHA256 = hash(new TextEncoder().encode(emitted))
  assert(emitted.includes('| undefined') && emitted.includes('last: number'))
  await writeFile(join(library, 'package.json'), JSON.stringify({ name: 'native-dtsx-contract', version: '1.0.0', type: 'module', files: ['dist'], exports: { '.': { types: './dist/nested/index.d.ts' } } }))
  const sdk = join(owned, 'native-contract.tgz')
  await run([process.execPath, '--no-env-file', 'pm', 'pack', '--filename', sdk], library)
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module', devDependencies: { typescript: '7.0.2' }, dependencies: { 'native-dtsx-contract': `file:${sdk}` } }))
  for (const frozen of [false, true]) {
    await run([cli, 'install', ...(frozen ? ['--frozen-lockfile'] : [])], consumer)
    assert.equal(await readFile(join(consumer, 'node_modules/native-dtsx-contract/dist/nested/index.d.ts'), 'utf8'), emitted)
    await controls('native-dtsx-contract')
  }
  receipt.completed = true
  console.log(`Public native DTSX original binary, zero npm runtime deps and strict authored/normal/frozen consumers PASS: ${owned}`)
}
finally {
  await writeFile(join(owned, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  await rm(join(owned, 'consumer/node_modules'), { recursive: true, force: true })
}
