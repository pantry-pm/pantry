import assert from 'node:assert/strict'
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

assert(process.env.PANTRY_TEST_CLI, 'Supply the actual source CLI')
const cli = resolve(process.env.PANTRY_TEST_CLI)
const evidence = resolve(process.env.PANTRY_GIT_EVIDENCE ?? 'artifacts/git-revision-identity')
await mkdir(evidence, { recursive: true })
const root = await mkdtemp(join(tmpdir(), 'pantry-git-revision-'))
const upstream = join(root, 'upstream')
const bare = join(root, 'upstream.git')
const hooks = join(root, 'empty-hooks')
await mkdir(upstream)
await mkdir(hooks)
const remote = 'https://github.com/pantry-fixture/revision-fixture.git'
const gitRemote = 'https://git.pantry-fixture.invalid/revision.git'
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Chris Breuer', GIT_AUTHOR_EMAIL: 'chris@stacksjs.com',
  GIT_COMMITTER_NAME: 'Chris Breuer', GIT_COMMITTER_EMAIL: 'chris@stacksjs.com',
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_COUNT: '4',
  GIT_CONFIG_KEY_0: `url.${pathToFileURL(bare).href}.insteadOf`, GIT_CONFIG_VALUE_0: remote,
  GIT_CONFIG_KEY_1: 'core.hooksPath', GIT_CONFIG_VALUE_1: hooks,
  GIT_CONFIG_KEY_2: 'commit.gpgsign', GIT_CONFIG_VALUE_2: 'false',
  GIT_CONFIG_KEY_3: `url.${pathToFileURL(bare).href}.insteadOf`, GIT_CONFIG_VALUE_3: gitRemote,
}
const commands: Array<{ label: string, args: string[], cwd: string, exit: number | null, stdout: string, stderr: string }> = []
const cases: Array<{ name: string, passed: boolean, error?: string }> = []
let sequence = 0

function run(label: string, args: string[], cwd: string, extra: Record<string, string> = {}) {
  const result = Bun.spawnSync(args, { cwd, env: { ...env, ...extra }, stdout: 'pipe', stderr: 'pipe', timeout: 45_000 })
  const stdout = result.stdout.toString()
  const stderr = result.stderr.toString()
  commands.push({ label, args, cwd, exit: result.exitCode, stdout, stderr })
  assert.equal(result.signalCode ?? null, null, `${label}: child terminated by ${result.signalCode}`)
  assert(!result.exitedDueToTimeout, `${label}: child timed out`)
  return { code: result.exitCode, stdout, stderr }
}

function git(cwd: string, ...args: string[]): string {
  const result = run('git', ['git', '-C', cwd, ...args], cwd)
  assert.equal(result.code, 0, result.stdout + result.stderr)
  return result.stdout.trim()
}

git(upstream, 'init', '--quiet', '-b', 'trunk')
await writeFile(join(upstream, 'value.txt'), 'pinned revision\n')
await writeFile(join(upstream, 'run.sh'), '#!/bin/sh\nprintf pinned\n')
await chmod(join(upstream, 'run.sh'), 0o755)
await symlink('value.txt', join(upstream, 'value-link'))
git(upstream, 'add', '.')
git(upstream, 'commit', '--quiet', '-m', 'test: create pinned revision')
const wanted = git(upstream, 'rev-parse', 'HEAD')
git(upstream, 'branch', 'older')
git(upstream, 'tag', '-a', 'release-old', '-m', 'pinned release')
await writeFile(join(upstream, 'value.txt'), 'default branch revision\n')
git(upstream, 'commit', '--quiet', '-am', 'test: advance default branch')
const latest = git(upstream, 'rev-parse', 'HEAD')
git(upstream, 'clone', '--quiet', '--bare', upstream, bare)

async function fixture(source: 'github' | 'git', version: string, fields: Record<string, string> = {}, dotted = false) {
  const index = sequence++
  const directory = join(root, `consumer-${index}`)
  const name = `revision-fixture-${root.split(/[/\\]/).pop()}-${index}${dotted ? '.pkg' : ''}`
  await mkdir(directory)
  const dependency = source === 'github' ? { source, repo: 'pantry-fixture/revision-fixture', version, ...fields } : { source, url: `git+${gitRemote}`, version, ...fields }
  async function manifest(next: typeof dependency | string = dependency) {
    await writeFile(join(directory, 'pantry.json'), JSON.stringify({ name: 'git-identity-contract', dependencies: { [name]: next } }))
  }
  await manifest()
  return { directory, name, installed: join(directory, 'pantry', name), manifest, dependency,
    install: (frozen = false) => run('install', [cli, 'install', '--ignore-scripts', '--verbose', ...(frozen ? ['--frozen-lockfile'] : [])], directory, {
      XDG_DATA_HOME: join(directory, 'data'), XDG_CACHE_HOME: join(directory, 'cache'),
    }) }
}

async function check(name: string, operation: () => Promise<void>) {
  try { await operation(); cases.push({ name, passed: true }) }
  catch (error) { cases.push({ name, passed: false, error: String(error) }) }
}

try {
  for (const source of ['github', 'git'] as const) {
    for (const [label, version, expected] of [['commit', wanted, wanted], ['branch', 'older', wanted], ['annotated-tag', 'release-old', wanted], ['default', 'latest', latest]]) {
      await check(`${source}: ${label}`, async () => {
        const f = await fixture(source, version!)
        const result = f.install()
        assert.equal(result.code, 0, result.stdout + result.stderr)
        assert.equal(git(f.installed, 'rev-parse', 'HEAD'), expected)
        assert.equal((await lstat(join(f.installed, 'run.sh'))).mode & 0o777, 0o755)
        assert.equal(await readlink(join(f.installed, 'value-link')), 'value.txt')
        assert.equal(await readFile(join(f.installed, 'value.txt'), 'utf8'), expected === wanted ? 'pinned revision\n' : 'default branch revision\n')
      })
    }
    await check(`${source}: explicit source with a dotted package name`, async () => {
      const f = await fixture(source, wanted, {}, true)
      const installed = f.install()
      assert.equal(installed.code, 0, installed.stdout + installed.stderr)
      assert.equal(git(f.installed, 'rev-parse', 'HEAD'), wanted)
    })
    for (const field of ['branch', 'tag']) {
      await check(`${source}: explicit ${field}`, async () => {
        const f = await fixture(source, 'latest', { [field]: field === 'branch' ? 'older' : 'release-old' })
        const result = f.install()
        assert.equal(result.code, 0, result.stdout + result.stderr)
        assert.equal(git(f.installed, 'rev-parse', 'HEAD'), wanted)
      })
    }
    await check(`${source}: invalid ref preserves the previous revision`, async () => {
      const f = await fixture(source, 'older')
      const initial = f.install()
      assert.equal(initial.code, 0, initial.stdout + initial.stderr)
      assert.equal(git(f.installed, 'rev-parse', 'HEAD'), wanted)
      await f.manifest({ ...f.dependency, version: 'missing-ref-do-not-use-HEAD' })
      const failed = f.install()
      assert.notEqual(failed.code, 0, failed.stdout + failed.stderr)
      assert.equal(git(f.installed, 'rev-parse', 'HEAD'), wanted)
      assert.equal(await readFile(join(f.installed, 'value.txt'), 'utf8'), 'pinned revision\n')
    })
    await check(`${source}: repair an existing wrong revision without force`, async () => {
      const f = await fixture(source, wanted)
      await mkdir(join(f.directory, 'pantry'))
      git(upstream, 'clone', '--quiet', source === 'github' ? remote : gitRemote, f.installed)
      assert.equal(git(f.installed, 'rev-parse', 'HEAD'), latest)
      const repaired = f.install()
      assert.equal(repaired.code, 0, repaired.stdout + repaired.stderr)
      assert.equal(git(f.installed, 'rev-parse', 'HEAD'), wanted)
    })
    for (const damage of ['HEAD', 'tracked file', 'origin']) {
      await check(`${source}: repair ${damage} with an existing lock`, async () => {
        const f = await fixture(source, wanted)
        const initial = f.install()
        assert.equal(initial.code, 0, initial.stdout + initial.stderr)
        if (damage === 'HEAD') git(f.installed, 'checkout', '--quiet', '--detach', latest)
        else if (damage === 'origin') git(f.installed, 'remote', 'set-url', 'origin', 'https://invalid.example/wrong-source.git')
        else await writeFile(join(f.installed, 'value.txt'), 'modified checkout\n')
        const repaired = f.install()
        assert.equal(repaired.code, 0, repaired.stdout + repaired.stderr)
        assert.equal(git(f.installed, 'rev-parse', 'HEAD'), wanted)
        assert.equal(git(f.installed, 'config', '--local', '--get', 'remote.origin.url'), source === 'github' ? remote : gitRemote)
        assert.equal(await readFile(join(f.installed, 'value.txt'), 'utf8'), 'pinned revision\n')
      })
    }
    for (const ref of [wanted, undefined]) {
      await check(`${source}: shorthand ${ref ? 'commit' : 'remote default branch'}`, async () => {
        const f = await fixture(source, 'latest')
        const url = source === 'github' ? 'github:pantry-fixture/revision-fixture' : `git+${gitRemote}`
        await f.manifest(`${url}${ref ? `#${ref}` : ''}`)
        const installed = f.install()
        assert.equal(installed.code, 0, installed.stdout + installed.stderr)
        assert.equal(git(f.installed, 'rev-parse', 'HEAD'), ref ?? latest)
      })
    }
    await check(`${source}: fresh frozen commit identity`, async () => {
      const f = await fixture(source, wanted)
      const normal = f.install()
      assert.equal(normal.code, 0, normal.stdout + normal.stderr)
      assert.equal(git(f.installed, 'rev-parse', 'HEAD'), wanted)
      const lock = await readFile(join(f.directory, 'pantry.lock'))
      await rm(join(f.directory, 'pantry'), { recursive: true, force: true })
      const frozen = f.install(true)
      assert.equal(frozen.code, 0, frozen.stdout + frozen.stderr)
      assert.equal(git(f.installed, 'rev-parse', 'HEAD'), wanted)
      assert.deepEqual(await readFile(join(f.directory, 'pantry.lock')), lock)
    })
  }
}
finally {
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify({ passed: cases.length === 30 && cases.every(item => item.passed), cli, root, wanted, latest, cases, commands }, null, 2) + '\n')
  await rm(root, { recursive: true, force: true })
}
console.log(JSON.stringify(cases, null, 2))
assert.equal(cases.length, 30)
assert(cases.every(item => item.passed), 'Git revision contract failed; see retained receipt')
