import type { Stats } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { expect, test } from 'bun:test'

const manifestPath = resolve(import.meta.dir, '../package.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { scripts: { build: string } }
const build = manifest.scripts.build

interface PackageBuild {
  directory: string
  name: string
  exitCode: number
}

interface BuildEvent {
  name: string
  cwd: string
  exitCode: number
}

async function workspaceBuild(label: string, packages: PackageBuild[], expectedExit: number, expectedNames: string[]): Promise<void> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pantry workspace build ')))
  const owner: Stats = lstatSync(root)
  const eventsPath = join(root, 'build-order.jsonl')
  const secondary: unknown[] = []
  let primary: unknown
  let failed = false
  let removed = false
  let observation: Record<string, unknown> = { label, root, rootOwner: { dev: owner.dev, ino: owner.ino, mode: owner.mode }, sourceManifest: manifestPath, build, bun: process.execPath, bunVersion: Bun.version }

  try {
    mkdirSync(join(root, 'packages'))
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      name: 'workspace-build-control', private: true, workspaces: ['packages/*'], scripts: { build },
    }))
    for (const pkg of packages) {
      const directory = join(root, 'packages', pkg.directory)
      mkdirSync(directory)
      writeFileSync(join(directory, 'package.json'), JSON.stringify({
        name: `fixture-${pkg.name}`, private: true, scripts: { build: 'bun build.ts' },
      }))
      writeFileSync(join(directory, 'build.ts'), `import { appendFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
appendFileSync(join(import.meta.dir, '..', '..', 'build-order.jsonl'), JSON.stringify({ name: ${JSON.stringify(pkg.name)}, cwd: realpathSync(process.cwd()), exitCode: ${pkg.exitCode} }) + '\\n')
process.exit(${pkg.exitCode})
`)
    }
    // The only external program in the actual root script is the same Bun
    // running this test. Child scripts use builtins, with no install or network.
    const env: Record<string, string> = { PATH: dirname(process.execPath) }
    for (const key of ['HOME', 'SYSTEMROOT', 'WINDIR', 'TMPDIR', 'TEMP', 'TMP']) {
      const value = process.env[key]
      if (value !== undefined) env[key] = value
    }
    const child = Bun.spawn([process.execPath, 'run', 'build'], {
      cwd: root, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 10_000,
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ])
    const events: BuildEvent[] = existsSync(eventsPath)
      ? readFileSync(eventsPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as BuildEvent)
      : []
    observation = { ...observation, exitCode, stdout, stderr, events, packages }

    expect(exitCode).toBe(expectedExit)
    expect(events.map(event => event.name)).toEqual(expectedNames)
    expect(events.map(event => event.cwd)).toEqual(expectedNames.map(name => {
      const pkg = packages.find(item => item.name === name)!
      return join(root, 'packages', pkg.directory)
    }))
    expect(events.map(event => event.exitCode)).toEqual(expectedNames.map(name => packages.find(item => item.name === name)!.exitCode))
  }
  catch (error) {
    failed = true
    primary = error
  }
  finally {
    // Keep failing fixtures for the original witness. Successful cases remove
    // only the mkdtemp root whose original directory identity still matches.
    if (!failed) {
      try {
        const current = lstatSync(root)
        if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== owner.dev || current.ino !== owner.ino || realpathSync(root) !== root)
          throw new Error('Refusing cleanup after owned fixture root identity changed')
        rmSync(root, { recursive: true })
        removed = true
      }
      catch (error) { secondary.push(error) }
    }
    const evidence = process.env.PANTRY_WORKSPACE_BUILD_EVIDENCE
    if (evidence) {
      try {
        const file = join(evidence, `${label}-${basename(root)}-${randomUUID()}.json`)
        // The caller owns this explicit evidence directory; never overwrite a receipt.
        writeFileSync(file, `${JSON.stringify({
          ...observation, rootRemoved: removed, rootRetained: existsSync(root),
          primaryError: failed ? String(primary) : null, secondaryErrors: secondary.map(String),
        }, null, 2)}\n`, { flag: 'wx' })
        console.info(`Workspace build evidence: ${file}`)
      }
      catch (error) { secondary.push(error) }
    }
    if (failed || secondary.length) {
      try { console.info(`Workspace build fixture: ${root}`) }
      catch (error) { secondary.push(error) }
    }
    if (failed) {
      for (const error of [...secondary]) {
        try { console.error('Secondary workspace build fixture failure:', error) }
        catch (writeError) { secondary.push(writeError) }
      }
      throw primary
    }
    if (secondary.length) throw new AggregateError(secondary, 'Required workspace build observation or cleanup failed')
  }
}

test('workspace build preserves an early child failure and stops later packages', async () => {
  await workspaceBuild('early-failure', [
    { directory: '01-first', name: 'first', exitCode: 17 },
    { directory: '02-later', name: 'later', exitCode: 0 },
  ], 17, ['first'])
}, 30_000)

test('workspace build visits successful packages in order', async () => {
  await workspaceBuild('all-success', [
    { directory: '01-first', name: 'first', exitCode: 0 },
    { directory: '02-second', name: 'second', exitCode: 0 },
    { directory: '03-third', name: 'third', exitCode: 0 },
  ], 0, ['first', 'second', 'third'])
}, 30_000)

test('workspace build preserves package directories containing spaces', async () => {
  await workspaceBuild('spaced-directories', [
    { directory: '01-first package', name: 'first', exitCode: 0 },
    { directory: '02-second package', name: 'second', exitCode: 0 },
  ], 0, ['first', 'second'])
}, 30_000)
