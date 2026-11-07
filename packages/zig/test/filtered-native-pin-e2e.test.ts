import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'bun:test'

const binary = process.env.PANTRY_SOURCE_CLI

// The embedded zstd catalog edge is real: facebook.com/zstd@1.5.7 requires
// lz4.org^1. Only authored declarations and ordinary CLI operations change.
describe.skipIf(!binary)('source CLI filtered companion pin policy', () => {
  it('retains the real zstd child pin through filtered normal and frozen companion installs', () => {
    const root = mkdtempSync(join(tmpdir(), 'pantry-filtered-transitive-pin-'))
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
        ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: join(root, 'local-app-data'), PANTRY_ENV_DEPS: '0', PANTRY_REGISTRY_ACCELERATION: '0',
        XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache'), XDG_CONFIG_HOME: join(root, 'config'),
      }
      const data = process.platform === 'darwin' ? join(home, '.local/share/pantry')
        : process.platform === 'win32' ? join(env.LOCALAPPDATA, 'pantry/data') : join(env.XDG_DATA_HOME, 'pantry')
      const globalPackages = join(data, 'global/packages')
      const lockPath = join(root, 'pantry.lock')
      function nativeInventory(base: string): { versions: Record<string, string[]>, errors: { path: string, error: string }[] } {
        const discovered = new Map<string, Set<string>>()
        const errors: { path: string, error: string }[] = []
        function visit(path: string, domain: string[]) {
          try {
            // lstat and Dirent checks never follow a root or descendant symlink.
            // Unlike a final-lock-derived list, this walk also sees unknown domains.
            const stat = lstatSync(path)
            if (!stat.isDirectory()) {
              if (domain.length === 0) errors.push({ path, error: 'Native inventory root is not a real directory' })
              return
            }
            for (const entry of readdirSync(path, { withFileTypes: true })) {
              if (!entry.isDirectory() || entry.isSymbolicLink()) continue
              if (/^v\d/.test(entry.name)) {
                const canonical = domain.join('/')
                const versions = discovered.get(canonical) ?? new Set<string>()
                versions.add(entry.name.slice(1))
                discovered.set(canonical, versions)
                // A version directory is payload, not another domain component.
                continue
              }
              visit(join(path, entry.name), [...domain, entry.name])
            }
          }
          catch (error) {
            if (domain.length === 0 && (error as NodeJS.ErrnoException).code === 'ENOENT') return
            errors.push({ path, error: error instanceof Error ? error.message : String(error) })
          }
        }
        // Check every fixture-owned ancestor before visiting the store, so a
        // replaced global/data parent cannot redirect this read outside the fixture.
        let cursor = root
        try {
          for (const part of relative(root, base).split(sep)) {
            cursor = join(cursor, part)
            if (!lstatSync(cursor).isDirectory()) {
              errors.push({ path: cursor, error: 'Native inventory path is not a real directory' })
              return { versions: {}, errors }
            }
          }
          visit(base, [])
        }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') errors.push({ path: cursor, error: error instanceof Error ? error.message : String(error) })
        }
        const versions = Object.fromEntries([...discovered].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([domain, values]) => [domain, [...values].sort()]))
        return { versions, errors }
      }

      function observe(name: string, args = ['install', '--ignore-scripts', '--quiet']) {
        phase = name
        const result = spawnSync(binary!, args, { cwd: root, env, encoding: 'utf8', timeout: 30_000 })
        writeFileSync(join(root, `${name}.stdout`), result.stdout ?? '')
        writeFileSync(join(root, `${name}.stderr`), result.stderr ?? '')
        writeFileSync(join(root, `${name}.result.json`), JSON.stringify({
          sourceCLISHA256: new Bun.CryptoHasher('sha256').update(readFileSync(binary!)).digest('hex'), args, status: result.status, signal: result.signal, error: result.error?.message,
          seedEstablished, resolutionMode: 'client-default', declarations: readFileSync(deps, 'utf8'),
        }))
        const physical = { project: nativeInventory(join(root, 'pantry')), global: nativeInventory(globalPackages) }
        writeFileSync(join(root, `${name}.physical-inventory.json`), JSON.stringify(physical))
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
        expect(physical.project.errors).toEqual([])
        expect(physical.global.errors).toEqual([])
        expect(physical.project.versions['lz4.org']).toEqual(['1.10.0'])
        expect(physical.project.versions['facebook.com/zstd']).toEqual(['1.5.7'])
        expect(physical.global.versions['lz4.org'] ?? []).not.toContain('1.11.0')
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
      const transitive = observe('normal-transitive-filtered', ['install', '--ignore-scripts', '--quiet', '--filter', '@pantry-fixture/local'])
      // Only the authored direct declaration disappeared. Preserve every
      // resolved seed entry, including any unrelated retained platform pins.
      const expected = structuredClone(seeded.lock)
      delete expected.workspaces[''].system['lz4.org']
      expect(transitive.lock).toEqual(expected)
      expect(observe('normal-repeated-filtered', ['install', '--ignore-scripts', '--quiet', '--filter', '@pantry-fixture/local']).text).toBe(transitive.text)
      expect(observe('frozen', ['install', '--ignore-scripts', '--quiet', '--filter', '@pantry-fixture/local', '--frozen-lockfile']).text).toBe(transitive.text)
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

})
