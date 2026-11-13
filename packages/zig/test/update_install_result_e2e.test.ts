import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, rmdirSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, delimiter, join } from 'node:path'

const binary = process.env.PANTRY_SOURCE_CLI

// Ordinary unit tests precede the native build. The source CLI CI pass supplies
// its just-built binary, as it does for workspace-companion-e2e.test.ts.
describe.skipIf(!binary || process.platform === 'win32')('source CLI update installation results', () => {
  let directory = ''
  let server: ReturnType<typeof Bun.serve> | undefined
  const requests: { method: string, path: string }[] = []

  function childEnvironment(): Record<string, string> {
    return {
      HOME: process.env.HOME ?? homedir(),
      PATH: `${join(directory, 'tools')}${delimiter}/usr/bin${delimiter}/bin`,
      TMPDIR: directory,
      XDG_DATA_HOME: join(directory, 'data'),
      XDG_CACHE_HOME: join(directory, 'cache'),
      PANTRY_ENV_DEPS: '0',
      // Public fixture data outranks native stored credential fallback. Do not
      // forward parent auth variables or inspect headers/credential files.
      PANTRY_REGISTRY_TOKEN: 'ptry_owned_update_result',
      NO_COLOR: '1',
      CI: '1',
    }
  }

  beforeAll(async () => {
    directory = realpathSync(mkdtempSync(join(tmpdir(), 'pantry-update-result-')))
    mkdirSync(join(directory, 'tools'))
    const hook = join(directory, 'hook.ts')
    writeFileSync(hook, `import { appendFileSync } from 'node:fs'
appendFileSync(process.env.PANTRY_UPDATE_HOOK_OBSERVATIONS!, JSON.stringify({
  executable: process.execPath, argv: process.argv.slice(2), cwd: process.cwd(),
}) + '\\n')
console.error('Owned update preinstall fixture exits 17')
process.exit(17)
`)
    const built = Bun.spawn([process.execPath, 'build', hook, '--compile', '--outfile', join(directory, 'tools', 'pantry-update-hook')], {
      cwd: directory, env: childEnvironment(),
      stdout: 'pipe', stderr: 'pipe', timeout: 30_000,
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(built.stdout).text(), new Response(built.stderr).text(), built.exited,
    ])
    expect(code, stdout + stderr).toBe(0)

    server = Bun.serve({
      hostname: '127.0.0.1', port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname
        requests.push({ method: request.method, path })
        if (path === '/binaries/update-result.invalid/metadata.json')
          return Response.json({ versions: { '1.0.0': {}, '2.0.0': {} } })
        return new Response('Unexpected registry request', { status: 500 })
      },
    })
  }, 35_000)

  afterAll(() => {
    server?.stop(true)
    if (directory) rmSync(directory, { recursive: true, force: true })
  })

  it('returns the real preinstall failure without an update success summary', async () => {
    const project = join(directory, `${basename(directory)} project with spaces`)
    mkdirSync(project)
    const manifest = join(project, 'pantry.json')
    writeFileSync(manifest, JSON.stringify({
      name: 'update-result-fixture', version: '1.0.0', global: false,
      dependencies: { 'update-result.invalid': '1.0.0' },
      scripts: { preinstall: 'pantry-update-hook' },
    }, null, 2))

    // Native Darwin paths do not use XDG. This invocation can create only its
    // own empty environment before the failing hook. Refuse pre-existing paths
    // and remove only empty directories that match that exact native identity.
    const data = process.platform === 'darwin'
      ? join(homedir(), '.local/share/pantry')
      : join(directory, 'data', 'pantry')
    const projectHash = createHash('md5').update(project).digest().readUInt32LE().toString(16).padStart(8, '0')
    const configHash = createHash('md5').update(manifest).digest('hex').slice(0, 8)
    const environment = join(data, 'envs', `${basename(project)}_${projectHash}-d${configHash}`)
    const inventory = (): string[] => {
      let state: ReturnType<typeof lstatSync>
      try {
        state = lstatSync(environment)
      }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw error
      }
      if (!state.isDirectory() || state.isSymbolicLink()) throw new Error('Unexpected owned environment type')
      const entries = readdirSync(environment)
      if (entries.length !== 1 || entries[0] !== 'bin') throw new Error('Unexpected owned environment entries')
      const bin = join(environment, 'bin')
      if (!lstatSync(bin).isDirectory() || lstatSync(bin).isSymbolicLink() || readdirSync(bin).length)
        throw new Error('Unexpected contents in the owned environment')
      return ['.', 'bin/']
    }
    // lstat distinguishes absent paths from dangling symlinks as well.
    expect(inventory()).toEqual([])
    const observations = join(directory, 'hook-observations.jsonl')
    try {
      const child = Bun.spawn([binary!, 'update', '--latest'], {
        cwd: project,
        env: {
          ...childEnvironment(),
          PANTRY_REGISTRY_URL: server!.url.origin,
          PANTRY_UPDATE_HOOK_OBSERVATIONS: observations,
        },
        stdout: 'pipe', stderr: 'pipe', timeout: 30_000,
      })
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ])
      const output = stdout + stderr
      const actual = readFileSync(observations, 'utf8').trim().split('\n').map(line => JSON.parse(line))
      expect(actual).toEqual([{
        executable: realpathSync(join(directory, 'tools', 'pantry-update-hook')),
        argv: [], cwd: realpathSync(project),
      }])
      expect(requests).toEqual([{ method: 'GET', path: '/binaries/update-result.invalid/metadata.json' }])
      expect(output).toContain('Owned update preinstall fixture exits 17')
      const after = inventory()
      expect(code, JSON.stringify({ output, actual, requests, environment, environmentBefore: [], environmentAfter: after })).toBe(1)
      expect(output).toContain('Pre-install hook failed')
      expect(output).not.toMatch(/Updated \d+ packages?/)
    }
    finally {
      if (inventory().length) {
        rmdirSync(join(environment, 'bin'))
        rmdirSync(environment)
      }
    }
  }, 35_000)
})
