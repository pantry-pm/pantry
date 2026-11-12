import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const cli = resolve(process.argv[2]!)
const owned = await mkdtemp(join(tmpdir(), 'pantry-js-add-'))
const results: Array<Record<string, unknown>> = []
async function run(command: string[], cwd: string) {
  const child = Bun.spawn(command, { cwd, stdout: 'pipe', stderr: 'pipe', timeout: 90_000 })
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  return { code, output: stdout + stderr }
}

async function installedVersion(cwd: string): Promise<string> {
  // A workspace upgrade can replace a symlink. Resolve in an actual new
  // consumer, rather than reuse this supervisor's cached module realpath.
  const probe = await run([process.execPath, '--no-env-file', '-e', `console.log((await Bun.file(Bun.resolveSync('is-number/package.json', process.cwd())).json()).version)`], cwd)
  assert.equal(probe.code, 0, probe.output)
  return probe.output.trim()
}

try {
  for (const scenario of [
    { name: 'normal', section: 'dependencies', flags: [] },
    { name: 'dev-short', section: 'devDependencies', flags: ['-D'] },
    { name: 'dev-long-exact', section: 'devDependencies', flags: ['--dev', '--exact'] },
    { name: 'peer', section: 'peerDependencies', flags: ['--peer'] },
    { name: 'optional', section: 'optionalDependencies', flags: ['--optional'] },
    { name: 'workspace-member', section: 'devDependencies', flags: ['-D'], member: true },
  ]) {
    const root = join(owned, scenario.name)
    const target = scenario.member ? join(root, 'packages/member') : root
    await mkdir(target, { recursive: true })
    await writeFile(join(root, 'deps.yaml'), 'dependencies:\n  bun.sh: 1.4.4\n')
    if (scenario.member) await writeFile(join(root, 'package.json'), JSON.stringify({ private: true, workspaces: ['packages/*'] }))
    await writeFile(join(target, 'package.json'), JSON.stringify({ name: `add-${scenario.name}`, private: true, [scenario.section]: { 'is-number': '6.0.0' } }))
    const original = await run([process.execPath, 'install'], root)
    assert.equal(original.code, 0, original.output)
    assert.equal(await installedVersion(target), '6.0.0')
    const added = await run([cli, 'add', ...scenario.flags, 'is-number@7.0.0'], target)
    const manifest = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'))
    const actualVersion = await installedVersion(target)
    const row = { scenario: scenario.name, exit: added.code, manifest, actualVersion, output: added.output, ok: false }
    results.push(row)
    try {
      assert.equal(added.code, 0, added.output)
      for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
        assert.equal(manifest[section]?.['is-number'], section === scenario.section ? (scenario.flags.includes('--exact') ? '7.0.0' : '^7.0.0') : undefined, `${scenario.name}: ${section}`)
      }
      assert.equal(actualVersion, '7.0.0', `${scenario.name}: actual installed graph must already be upgraded`)
      const locks = await Promise.all(['bun.lock', 'pantry.lock'].map(name => readFile(join(root, name), 'utf8')))
      assert(locks[0].includes('is-number@7.0.0'), 'The JavaScript lock must describe the installed version')
      const frozen = await run([cli, 'install', '--frozen-lockfile'], target)
      assert.equal(frozen.code, 0, frozen.output)
      assert.deepEqual(await Promise.all(['bun.lock', 'pantry.lock'].map(name => readFile(join(root, name), 'utf8'))), locks)
      assert.equal(await installedVersion(target), '7.0.0')
      row.ok = true
    }
    catch (error) {
      Object.assign(row, { error: String(error) })
      console.error(`${scenario.name}: ${error}`)
    }
  }
  const rejected = join(owned, 'rejected-version')
  await mkdir(rejected)
  const originalManifest = '{ "private": true, "devDependencies": { "is-number": "6.0.0" } }\n'
  await writeFile(join(rejected, 'package.json'), originalManifest)
  const baseline = await run([process.execPath, 'install'], rejected)
  assert.equal(baseline.code, 0, baseline.output)
  const originalLock = await readFile(join(rejected, 'bun.lock'), 'utf8')
  const failed = await run([cli, 'add', '-D', 'is-number@7.0.999999'], rejected)
  assert.notEqual(failed.code, 0, 'An unresolvable version must fail')
  assert.equal(await readFile(join(rejected, 'package.json'), 'utf8'), originalManifest, 'A failed addition must restore exact original manifest bytes')
  assert.equal(await readFile(join(rejected, 'bun.lock'), 'utf8'), originalLock)
  assert.equal(await installedVersion(rejected), '6.0.0')
  results.push({ scenario: 'failed version preserves manifest and installed graph', ok: true })
  if (process.env.PANTRY_ADD_EVIDENCE) await writeFile(process.env.PANTRY_ADD_EVIDENCE, JSON.stringify(results, null, 2) + '\n')
  assert(results.every(row => row.ok), `${results.filter(row => !row.ok).length} actual CLI add scenarios failed`)
  console.log(`Actual JS add, installed graph and frozen root/member locks PASS: ${results.length}`)
}
finally {
  await rm(owned, { recursive: true, force: true })
}
