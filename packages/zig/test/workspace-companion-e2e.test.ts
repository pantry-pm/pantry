import { describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const binary = process.env.PANTRY_SOURCE_CLI

// The normal unit pass runs before the CLI is built. CI invokes this suite
// again with the source binary, and verifies its exact commit before testing.
describe.skipIf(!binary)('source CLI companion workspace lifecycle', () => {
  it('reports required project setup failures and retries only incomplete setup', () => {
    const configurations = [
      { services: { postDatabaseSetup: ['exit 37', 'printf unexpected > after-hook.txt'] } },
      { postSetup: { commands: [{ command: 'exit 37', required: true }, { command: 'printf unexpected > after-hook.txt' }] } },
      { postSetup: { commands: [{ command: 'exit 37' }, { command: 'printf unexpected > after-hook.txt' }] } },
    ]
    for (const config of configurations) {
      const root = mkdtempSync(join(tmpdir(), 'pantry-required-setup-'))
      try {
        mkdirSync(join(root, 'pantry/.bin'), { recursive: true })
        symlinkSync(process.execPath, join(root, 'pantry/.bin/bun'))
        writeFileSync(join(root, 'package.json'), '{"name":"required-setup","private":true}')
        writeFileSync(join(root, 'deps.yaml'), 'dependencies: {}\n')
        const configPath = join(root, 'pantry.config.ts')
        writeFileSync(configPath, `export default ${JSON.stringify(config)}\n`)
        const run = (args = ['install']) => {
          const result = spawnSync(binary!, args, { cwd: root, encoding: 'utf8', timeout: 15_000 })
          if (result.error) throw result.error
          return result
        }
        const failed = run()
        expect(failed.stdout + failed.stderr).toContain('failed (exit 37)')
        expect(failed.status).not.toBe(0)
        expect(existsSync(join(root, 'after-hook.txt'))).toBe(false)
        expect(existsSync(join(root, 'pantry/.postsetup-done'))).toBe(false)

        writeFileSync(configPath, 'export default { services: { postDatabaseSetup: ["printf repaired > after-hook.txt"] } }\n')
        expect(run().status).toBe(0)
        expect(readFileSync(join(root, 'after-hook.txt'), 'utf8')).toBe('repaired')
        expect(existsSync(join(root, 'pantry/.postsetup-done'))).toBe(true)
        writeFileSync(configPath, `export default ${JSON.stringify(config)}\n`)
        expect(run().status).toBe(0)
        expect(run(['install', '--force']).status).not.toBe(0)
        expect(existsSync(join(root, 'pantry/.postsetup-done'))).toBe(false)
      }
      finally { rmSync(root, { recursive: true, force: true }) }
    }
  }, 30_000)

  it('keeps explicitly optional project setup failures nonfatal', () => {
    const root = mkdtempSync(join(tmpdir(), 'pantry-optional-setup-'))
    try {
      mkdirSync(join(root, 'pantry/.bin'), { recursive: true })
      symlinkSync(process.execPath, join(root, 'pantry/.bin/bun'))
      writeFileSync(join(root, 'package.json'), '{"name":"optional-setup","private":true}')
      writeFileSync(join(root, 'deps.yaml'), 'dependencies: {}\n')
      writeFileSync(join(root, 'pantry.config.ts'), 'export default { postSetup: { commands: [{ command: "exit 29", required: false }, { command: "printf continued > after-hook.txt" }] } }\n')
      const result = spawnSync(binary!, ['install'], { cwd: root, encoding: 'utf8', timeout: 15_000 })
      if (result.error) throw result.error
      expect(result.status).toBe(0)
      expect(readFileSync(join(root, 'after-hook.txt'), 'utf8')).toBe('continued')
      expect(existsSync(join(root, 'pantry/.postsetup-done'))).toBe(true)
    }
    finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('bootstraps a companion Bun before completing a fresh JS workspace', () => {
    const root = mkdtempSync(join(tmpdir(), 'pantry-companion-bootstrap-'))
    try {
      const member = join(root, 'packages/local')
      mkdirSync(member, { recursive: true })
      writeFileSync(join(root, 'package.json'), JSON.stringify({
        name: 'pantry-bootstrap-workspace', private: true, workspaces: ['packages/*'],
        dependencies: { '@pantry-fixture/bootstrap': 'workspace:*' },
      }))
      writeFileSync(join(member, 'package.json'), JSON.stringify({ name: '@pantry-fixture/bootstrap', version: '1.0.0' }))
      writeFileSync(join(root, 'deps.yaml'), 'dependencies:\n  bun.sh: 1.4.3\n')
      const env = { ...process.env, PATH: '/usr/bin:/bin', XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache') }
      expect(spawnSync('bun', ['--version'], { env }).error).toBeDefined()
      function run(args: string[], success = true): string {
        const result = spawnSync(binary!, args, { cwd: root, env, encoding: 'utf8', timeout: 45_000 })
        if (result.error) throw result.error
        const output = result.stdout + result.stderr
        if (success && result.status !== 0) throw new Error(output)
        if (!success) expect(result.status).not.toBe(0)
        return output
      }
      run(['install'])
      expect(realpathSync(join(root, 'node_modules/@pantry-fixture/bootstrap'))).toBe(realpathSync(member))
      const bun = spawnSync(join(root, 'pantry/.bin/bun'), ['--version'], { env, encoding: 'utf8' })
      expect(bun.status).toBe(0)
      expect(bun.stdout.trim()).toBe('1.4.3')
      const lockPath = join(root, 'pantry.lock')
      const lock = readFileSync(lockPath, 'utf8')
      expect(JSON.parse(lock).workspaces['packages/local'].name).toBe('@pantry-fixture/bootstrap')
      run(['install', '--frozen-lockfile'])
      expect(readFileSync(lockPath, 'utf8')).toBe(lock)

      // Explicit temporary native tools must honor --no-save just like a
      // workspace install. Keep every existing declaration and lock byte.
      const packageBeforeNoSave = readFileSync(join(root, 'package.json'), 'utf8')
      const depsBeforeNoSave = readFileSync(join(root, 'deps.yaml'), 'utf8')
      run(['install', 'bun.com@1.4.2', '--no-save', '--ignore-scripts'])
      expect(readFileSync(lockPath, 'utf8')).toBe(lock)
      expect(readFileSync(join(root, 'package.json'), 'utf8')).toBe(packageBeforeNoSave)
      expect(readFileSync(join(root, 'deps.yaml'), 'utf8')).toBe(depsBeforeNoSave)
      run(['install'])
      expect(readFileSync(lockPath, 'utf8')).toBe(lock)

      // A real managed Bun lifecycle failure must not publish the staged
      // combined lock, even though the companion runtime installed correctly.
      const manifest = join(root, 'package.json')
      const original = readFileSync(manifest, 'utf8')
      writeFileSync(manifest, JSON.stringify({ ...JSON.parse(original), scripts: { postinstall: 'bun -e "process.exit(27)"' } }))
      expect(run(['install'], false)).toContain('JavaScript dependency installation failed')
      expect(readFileSync(lockPath, 'utf8')).toBe(lock)
      expect(readdirSync(root).filter(name => name.startsWith('.pantry.lock.'))).toEqual([])
      writeFileSync(manifest, original)
      run(['install'])
      expect(readFileSync(lockPath, 'utf8')).toBe(lock)
    }
    finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)

  // Public CLI seam: normal generation seeds the exact native pin. Only the
  // authored companion constraint changes; no generated lock is edited.
  it('keeps a compatible companion native pin when its declared range widens', () => {
    const root = mkdtempSync(join(tmpdir(), 'pantry-companion-compatible-pin-'))
    let passed = false
    try {
      const member = join(root, 'packages/local')
      mkdirSync(member, { recursive: true })
      writeFileSync(join(root, 'package.json'), JSON.stringify({
        name: 'pantry-compatible-pin-workspace', private: true, workspaces: ['packages/*'],
        dependencies: { '@pantry-fixture/local': 'workspace:*' },
      }))
      writeFileSync(join(member, 'package.json'), JSON.stringify({ name: '@pantry-fixture/local', version: '1.0.0', private: true }))
      const deps = join(root, 'deps.yaml')
      writeFileSync(deps, 'dependencies:\n  lz4.org: 1.10.0\n')
      const home = join(root, 'home')
      mkdirSync(home)
      const env = {
        ...process.env, HOME: home, PANTRY_ENV_DEPS: '0',
        XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache'), XDG_CONFIG_HOME: join(root, 'config'),
      }
      const lockPath = join(root, 'pantry.lock')
      const executable = join(root, 'pantry/.bin', process.platform === 'win32' ? 'lz4.exe' : 'lz4')
      function observe(phase: string, args = ['install', '--ignore-scripts', '--quiet']) {
        const result = spawnSync(binary!, args, { cwd: root, env, encoding: 'utf8', timeout: 30_000 })
        // Preserve the actual CLI result, generated bytes and installed native
        // identity before any assertion, cleanup or another installer run.
        writeFileSync(join(root, `${phase}.stdout`), result.stdout ?? '')
        writeFileSync(join(root, `${phase}.stderr`), result.stderr ?? '')
        writeFileSync(join(root, `${phase}.result.json`), JSON.stringify({ status: result.status, signal: result.signal, error: result.error?.message }))
        const text = existsSync(lockPath) ? readFileSync(lockPath, 'utf8') : null
        if (text !== null) writeFileSync(join(root, `${phase}.pantry.lock`), text)
        const installed = spawnSync(executable, ['--version'], { cwd: root, env, encoding: 'utf8', timeout: 5000 })
        const version = (installed.stdout ?? '') + (installed.stderr ?? '')
        writeFileSync(join(root, `${phase}.installed.json`), JSON.stringify({ executable, status: installed.status, signal: installed.signal, error: installed.error?.message, output: version }))
        if (result.error) throw result.error
        expect(result.status, result.stdout + result.stderr).toBe(0)
        expect(result.signal).toBeNull()
        expect(text).not.toBeNull()
        if (text === null) throw new Error('The source CLI did not generate pantry.lock')
        if (installed.error) throw installed.error
        expect(installed.status, version).toBe(0)
        expect(installed.signal).toBeNull()
        expect(version).toMatch(/\bv1\.10\.0\b/)
        const lock = JSON.parse(text)
        const native = Object.entries(lock.packages).filter(([, entry]) => (entry as { name: string }).name === 'lz4.org')
        expect(native).toEqual([['lz4.org@1.10.0', {
          name: 'lz4.org', version: '1.10.0', source: 'pantry', resolved: 'registry:lz4.org@1.10.0',
        }]])
        return { text, lock }
      }

      const seeded = observe('seed-exact')
      expect(seeded.lock.workspaces[''].system['lz4.org']).toBe('1.10.0')
      expect(realpathSync(join(root, 'node_modules/@pantry-fixture/local'))).toBe(realpathSync(member))
      writeFileSync(deps, 'dependencies:\n  lz4.org: ^1.10.0\n')
      const widened = observe('normal-widened')
      // The declaration legitimately changes. Every resolved package and
      // unrelated workspace field must retain the normally generated seed.
      const expected = structuredClone(seeded.lock)
      expected.workspaces[''].system['lz4.org'] = '^1.10.0'
      expect(widened.lock).toEqual(expected)
      const repeated = observe('normal-repeated')
      expect(repeated.text).toBe(widened.text)
      const frozen = observe('frozen', ['install', '--ignore-scripts', '--quiet', '--frozen-lockfile'])
      expect(frozen.text).toBe(widened.text)
      expect(readFileSync(deps, 'utf8')).toBe('dependencies:\n  lz4.org: ^1.10.0\n')
      passed = true
    }
    finally {
      if (passed) rmSync(root, { recursive: true, force: true })
      else process.stdout.write(`Companion compatible-pin RED evidence retained: ${root}\n`)
    }
  }, 60_000)

  // The real embedded zstd catalog edge is lz4.org^1. Normal generation
  // seeds the exact child pin; removing its direct declaration tests that edge.
  it('keeps a compatible transitive native pin after its direct declaration is removed', () => {
    const root = mkdtempSync(join(tmpdir(), 'pantry-transitive-compatible-pin-'))
    let passed = false
    let phase = 'setup'
    let seedEstablished = false
    try {
      const member = join(root, 'packages/local')
      mkdirSync(member, { recursive: true })
      writeFileSync(join(root, 'package.json'), JSON.stringify({
        name: 'pantry-transitive-pin-workspace', private: true, workspaces: ['packages/*'],
        dependencies: { '@pantry-fixture/local': 'workspace:*' },
      }))
      writeFileSync(join(member, 'package.json'), JSON.stringify({ name: '@pantry-fixture/local', version: '1.0.0', private: true }))
      const deps = join(root, 'deps.yaml')
      const seededDeclarations = 'dependencies:\n  lz4.org: 1.10.0\n  facebook.com/zstd: 1.5.7\n'
      const transitiveDeclarations = 'dependencies:\n  facebook.com/zstd: 1.5.7\n'
      writeFileSync(deps, seededDeclarations)
      const home = join(root, 'home')
      mkdirSync(home)
      const env = {
        ...process.env, HOME: home, PANTRY_ENV_DEPS: '0', PANTRY_REGISTRY_ACCELERATION: '0',
        XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache'), XDG_CONFIG_HOME: join(root, 'config'),
      }
      const lockPath = join(root, 'pantry.lock')
      function observe(name: string, args = ['install', '--ignore-scripts', '--quiet']) {
        phase = name
        const result = spawnSync(binary!, args, { cwd: root, env, encoding: 'utf8', timeout: 30_000 })
        writeFileSync(join(root, `${name}.stdout`), result.stdout ?? '')
        writeFileSync(join(root, `${name}.stderr`), result.stderr ?? '')
        writeFileSync(join(root, `${name}.result.json`), JSON.stringify({
          args, status: result.status, signal: result.signal, error: result.error?.message,
          seedEstablished, resolutionMode: 'client-default', declarations: readFileSync(deps, 'utf8'),
        }))
        const text = existsSync(lockPath) ? readFileSync(lockPath, 'utf8') : null
        if (text !== null) writeFileSync(join(root, `${name}.pantry.lock`), text)
        const identities = [['lz4', /\bv1\.10\.0\b/], ['zstd', /\bv1\.5\.7\b/]] as const
        const installed = identities.map(([program, expected]) => {
          const executable = join(root, 'pantry/.bin', process.platform === 'win32' ? `${program}.exe` : program)
          const observed = spawnSync(executable, ['--version'], { cwd: root, env, encoding: 'utf8', timeout: 5000 })
          return { executable, expected, observed, output: (observed.stdout ?? '') + (observed.stderr ?? '') }
        })
        // Preserve both actual binary results before the first assertion.
        writeFileSync(join(root, `${name}.installed.json`), JSON.stringify(installed.map(value => ({
          executable: value.executable, status: value.observed.status, signal: value.observed.signal,
          error: value.observed.error?.message, output: value.output,
        }))))
        if (result.error) throw result.error
        expect(result.status, result.stdout + result.stderr).toBe(0)
        expect(result.signal).toBeNull()
        expect(text).not.toBeNull()
        if (text === null) throw new Error('The source CLI did not generate pantry.lock')
        for (const identity of installed) {
          if (identity.observed.error) throw identity.observed.error
          expect(identity.observed.status, identity.output).toBe(0)
          expect(identity.observed.signal).toBeNull()
          expect(identity.output).toMatch(identity.expected)
        }
        const lock = JSON.parse(text)
        for (const [domain, version] of [['lz4.org', '1.10.0'], ['facebook.com/zstd', '1.5.7']]) {
          const entries = Object.entries(lock.packages).filter(([, entry]) => (entry as { name: string }).name === domain)
          expect(entries).toEqual([[`${domain}@${version}`, {
            name: domain, version, source: 'pantry', resolved: `registry:${domain}@${version}`,
          }]])
        }
        return { text, lock }
      }

      const seeded = observe('seed-exact')
      expect(seeded.lock.workspaces[''].system['lz4.org']).toBe('1.10.0')
      expect(seeded.lock.workspaces[''].system['facebook.com/zstd']).toBe('1.5.7')
      expect(realpathSync(join(root, 'node_modules/@pantry-fixture/local'))).toBe(realpathSync(member))
      seedEstablished = true
      writeFileSync(join(root, 'seed-established.json'), JSON.stringify({
        parent: 'facebook.com/zstd@1.5.7', child: 'lz4.org@1.10.0', embeddedConstraint: '^1',
      }))
      writeFileSync(deps, transitiveDeclarations)
      const transitive = observe('normal-transitive-only')
      // Only the authored direct declaration disappeared. Preserve every
      // resolved seed entry, including any unrelated retained platform pins.
      const expected = structuredClone(seeded.lock)
      delete expected.workspaces[''].system['lz4.org']
      expect(transitive.lock).toEqual(expected)
      expect(observe('normal-repeated').text).toBe(transitive.text)
      expect(observe('frozen', ['install', '--ignore-scripts', '--quiet', '--frozen-lockfile']).text).toBe(transitive.text)
      expect(readFileSync(deps, 'utf8')).toBe(transitiveDeclarations)
      passed = true
    }
    catch (error) {
      writeFileSync(join(root, 'failure-classification.json'), JSON.stringify({
        phase, seedEstablished,
        classification: seedEstablished ? 'transitive-retention-oracle-failed' : 'seed-precondition-not-established',
        error: error instanceof Error ? error.message : String(error),
      }))
      throw error
    }
    finally {
      if (passed) rmSync(root, { recursive: true, force: true })
      else process.stdout.write(`Transitive compatible-pin RED evidence retained: ${root}\n`)
    }
  }, 60_000)

  it('locks internal-only workspaces and preserves their lock on companion failures', () => {
    const root = mkdtempSync(join(tmpdir(), 'pantry-companion-workspace-'))
    try {
      const member = join(root, 'packages/local')
      mkdirSync(member, { recursive: true })
      writeFileSync(join(root, 'package.json'), JSON.stringify({
        name: 'pantry-source-workspace',
        version: '1.0.0',
        private: true,
        workspaces: ['packages/*'],
        dependencies: { '@pantry-fixture/local': 'workspace:*' },
      }))
      writeFileSync(join(member, 'package.json'), JSON.stringify({ name: '@pantry-fixture/local', version: '1.0.0', private: true }))
      const deps = join(root, 'deps.yaml')
      writeFileSync(deps, 'dependencies:\n')
      const env = { ...process.env, XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache') }
      function run(args: string[], success = true): string {
        const result = spawnSync(binary!, args, { cwd: root, env, encoding: 'utf8', timeout: 30_000 })
        if (result.error) throw result.error
        const output = result.stdout + result.stderr
        if (success && result.status !== 0) throw new Error(output)
        if (!success) expect(result.status).not.toBe(0)
        return output
      }
      const revision = spawnSync('git', ['rev-parse', '--short=9', 'HEAD'], { cwd: resolve(import.meta.dir, '../../..'), encoding: 'utf8' })
      expect(revision.status).toBe(0)
      expect(run(['--version'])).toContain(revision.stdout.trim())

      run(['install'])
      const lockPath = join(root, 'pantry.lock')
      const committed = readFileSync(lockPath, 'utf8')
      const lock = JSON.parse(committed)
      expect(lock.workspaces[''].dependencies['@pantry-fixture/local']).toBe('workspace:*')
      expect(lock.workspaces['packages/local'].name).toBe('@pantry-fixture/local')
      expect(realpathSync(join(root, 'pantry/@pantry-fixture/local'))).toBe(realpathSync(member))
      run(['install', '--frozen-lockfile'])
      expect(readFileSync(lockPath, 'utf8')).toBe(committed)

      const memberManifest = join(member, 'package.json')
      const originalMember = readFileSync(memberManifest, 'utf8')
      writeFileSync(memberManifest, JSON.stringify({ name: '@pantry-fixture/local', version: '1.0.1', private: true }))
      run(['install', '--frozen-lockfile'], false)
      expect(readFileSync(lockPath, 'utf8')).toBe(committed)
      writeFileSync(memberManifest, originalMember)

      rmSync(deps)
      mkdirSync(deps)
      for (const args of [['install'], ['install', '--force']]) {
        expect(run(args, false)).toContain('Error installing deps.yaml')
        expect(readFileSync(lockPath, 'utf8')).toBe(committed)
        expect(readdirSync(root).filter(name => name.startsWith('.pantry.lock.'))).toEqual([])
      }
      rmSync(deps, { recursive: true })
      writeFileSync(deps, 'dependencies:\n')
      run(['install'])
      expect(readFileSync(lockPath, 'utf8')).toBe(committed)
    }
    finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)
})
