import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

const repository = resolve(import.meta.dir, '../..')
const cli = resolve(process.env.PANTRY_TEST_CLI ?? join(repository, 'packages/zig/zig-out/bin/pantry'))
const artifacts = resolve(process.env.PANTRY_RUNTIME_EVIDENCE ?? join(repository, 'artifacts/runtime-environment'))
await mkdir(artifacts, { recursive: true })
const owned = await mkdtemp(join(artifacts, 'native-runtime-'))
let project = join(owned, 'project with spaces')
await mkdir(project)
const fixture = join(repository, 'packages/ts-pantry/test/fixtures/runtime-environment')
const hash = (bytes: Uint8Array): string => Bun.SHA256.hash(bytes, 'hex')
const commands: Array<{ name: string, args: string[], code: number, log: string }> = []
const receipt: Record<string, unknown> = { completed: false, cli, commands, project }

async function run(name: string, args: string[], path = project): Promise<string> {
  const child = Bun.spawn(args, {
    cwd: path,
    env: { ...process.env, PATH: `${join(project, 'pantry/.bin')}${sep === '\\' ? ';' : ':'}${process.env.PATH ?? ''}` },
    stdout: 'pipe', stderr: 'pipe', signal: AbortSignal.timeout(120_000),
  })
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  const log = `${commands.length}-${name}.log`
  await writeFile(join(owned, log), stdout + stderr)
  commands.push({ name, args, code, log })
  assert.equal(code, 0, `${name}: ${stdout}\n${stderr}`)
  return stdout
}

let lockHash: string | undefined
let providerHash: string | undefined
async function check(phase: string): Promise<void> {
  const prefix = join(project, 'pantry/swig.org/v4.5.1')
  const swig = join(project, 'pantry/.bin/swig')
  const provider = join(prefix, 'bin/swig')
  const currentHash = hash(await readFile(provider))
  if (providerHash) assert.equal(currentHash, providerHash, 'Activation must not rewrite the native SWIG payload')
  else providerHash = currentHash
  const library = (await run(`${phase}-swig-library`, [swig, '-swiglib'])).trim()
  assert.equal(await realpath(library), await realpath(join(prefix, 'lib')))
  const resolved = (await run(`${phase}-provider`, [cli, 'which', 'swig', '--resolve'])).trim()
  assert.equal(await realpath(resolved), await realpath(provider))
  const build = join(project, `build-${phase}`)
  await run(`${phase}-configure`, [join(project, 'pantry/.bin/cmake'), '-S', join(project, 'source'), '-B', build,
    `-DPython3_ROOT_DIR=${join(project, 'pantry/python.org/v3.11.16')}`, `-DSWIG_EXECUTABLE=${swig}`])
  const discovered = (await readFile(join(build, 'discovered.txt'), 'utf8')).trim().split('\n')
  assert.equal(discovered.length, 4)
  const managed = await realpath(join(project, 'pantry'))
  for (const file of discovered) {
    const actual = await realpath(file)
    assert(actual.startsWith(`${managed}${sep}`), `Discovery escaped the declared packages: ${file}`)
  }
  await run(`${phase}-build`, [join(project, 'pantry/.bin/cmake'), '--build', build, '--parallel', '2'])
  const output = await run(`${phase}-import`, [join(project, 'pantry/.bin/python3'), '-c',
    'import sys; sys.path.insert(0, sys.argv[1]); import pantry_runtime_environment_probe as probe; assert probe.answer() == 42; print("PANTRY_RUNTIME_SWIG_PYTHON_OK")', build])
  assert.equal(output.trim(), 'PANTRY_RUNTIME_SWIG_PYTHON_OK')
  const currentLock = hash(await readFile(join(project, 'pantry.lock')))
  if (lockHash) assert.equal(currentLock, lockHash, 'Relocation and frozen installation must preserve the lock')
  else lockHash = currentLock
}

try {
  receipt.cliSHA256 = hash(await readFile(cli))
  receipt.cliVersion = (await run('version', [cli, '--version'])).trim()
  assert.equal(hash(await readFile(join(fixture, 'FindPythonAndSwig.cmake'))), '0ef0ffe6633202c005e0fe875b598f4d0e58181efa98e6a2b1e450115c1c03ee')
  await cp(fixture, join(project, 'source'), { recursive: true })
  await writeFile(join(project, 'deps.yaml'), 'dependencies:\n  bun.com: 1.4.4\n  cmake.org: 3.28.6\n  swig.org: 4.5.1\n  python.org: 3.11.16\n')
  await run('normal-install', [cli, 'install'])
  await check('normal')
  const relocated = join(owned, 'relocated project')
  await rename(project, relocated)
  project = relocated
  await check('relocated')
  await rm(join(project, 'pantry'), { recursive: true, force: true })
  await run('fresh-frozen-install', [cli, 'install', '--frozen-lockfile'])
  await check('frozen')
  Object.assign(receipt, { completed: true, project, lockSHA256: lockHash, nativeSwigSHA256: providerHash })
  console.log(`Runtime environment acceptance PASS: ${owned}`)
}
finally {
  // Keep bounded, top-level evidence paths so artifact collection never walks
  // installed Python package symlinks or duplicates the native payloads.
  const lock = Bun.file(join(project, 'pantry.lock'))
  if (await lock.exists()) await writeFile(join(owned, 'pantry.lock'), await lock.bytes())
  await writeFile(join(owned, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
}
