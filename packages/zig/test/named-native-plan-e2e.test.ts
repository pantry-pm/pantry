import { describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'

const binary = process.env.PANTRY_SOURCE_CLI
const flags = ['--ignore-scripts', '--quiet']
const exactDeclarations = 'dependencies:\n  lz4.org: 1.10.0\n  facebook.com/zstd: 1.5.7\n'

type LockEntry = { name: string, version: string, source: string, resolved?: string }
type GeneratedLock = { packages: Record<string, LockEntry>, workspaces: Record<string, { system?: Record<string, string> }> }

function fixture(declarations = 'dependencies:\n') {
  const root = mkdtempSync(join(tmpdir(), 'pantry-named-native-plan-'))
  const home = join(root, 'home')
  mkdirSync(home)
  const member = join(root, 'packages/local')
  mkdirSync(member, { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'pantry-named-native-plan', private: true, workspaces: ['packages/*'],
    dependencies: { '@pantry-fixture/local': 'workspace:*' },
  }))
  writeFileSync(join(member, 'package.json'), JSON.stringify({ name: '@pantry-fixture/local', version: '1.0.0', private: true }))
  writeFileSync(join(root, 'deps.yaml'), declarations)
  const env = {
    ...process.env, HOME: home, USERPROFILE: home, PANTRY_ENV_DEPS: '0', PANTRY_REGISTRY_ACCELERATION: '0',
    XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache'), XDG_CONFIG_HOME: join(root, 'config'),
    LOCALAPPDATA: join(root, 'local-app-data'),
  }
  // Actual Paths.data platform contract, confined to this fixture's HOME/XDG.
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

  function observe(phase: string, args: string[], installed = true) {
    const result = spawnSync(binary!, args, { cwd: root, env, encoding: 'utf8', timeout: 30_000 })
    const text = existsSync(lockPath) ? readFileSync(lockPath, 'utf8') : null
    writeFileSync(join(root, `${phase}.stdout`), result.stdout ?? '')
    writeFileSync(join(root, `${phase}.stderr`), result.stderr ?? '')
    writeFileSync(join(root, `${phase}.result.json`), JSON.stringify({ args, status: result.status, signal: result.signal, error: result.error?.message }))
    if (text !== null) writeFileSync(join(root, `${phase}.pantry.lock`), text)
    writeFileSync(join(root, `${phase}.deps.yaml`), readFileSync(join(root, 'deps.yaml')))
    let parsed: GeneratedLock | null = null
    let parseError: unknown
    try { parsed = text === null ? null : JSON.parse(text) }
    catch (error) { parseError = error }
    const project = nativeInventory(join(root, 'pantry'))
    const global = nativeInventory(globalPackages)
    const inventory = { project: project.versions, global: global.versions }
    const inventoryErrors = [...project.errors, ...global.errors]
    writeFileSync(join(root, `${phase}.inventory.json`), JSON.stringify({ ...inventory, errors: inventoryErrors }))
    const identities = installed ? [['lz4', /\bv1\.10\.0\b/], ['zstd', /\bv1\.5\.7\b/]] as const : []
    const executables = identities.map(([program, expected]) => {
      const executable = join(root, 'pantry/.bin', process.platform === 'win32' ? `${program}.exe` : program)
      const observed = spawnSync(executable, ['--version'], { cwd: root, env, encoding: 'utf8', timeout: 5000 })
      return { executable, expected, status: observed.status, signal: observed.signal, error: observed.error?.message, output: (observed.stdout ?? '') + (observed.stderr ?? '') }
    })
    writeFileSync(join(root, `${phase}.installed.json`), JSON.stringify(executables))
    if (parseError) throw parseError
    return { result, text, parsed, inventory, inventoryErrors, executables }
  }

  function success(observed: ReturnType<typeof observe>, identities = true) {
    if (observed.result.error) throw observed.result.error
    expect(observed.result.status, observed.result.stdout + observed.result.stderr).toBe(0)
    expect(observed.result.signal).toBeNull()
    expect(observed.parsed).not.toBeNull()
    expect(observed.inventoryErrors).toEqual([])
    if (identities) {
      for (const executable of observed.executables) {
        expect(executable.error, executable.output).toBeUndefined()
        expect(executable.status, executable.output).toBe(0)
        expect(executable.signal).toBeNull()
        expect(executable.output).toMatch(executable.expected)
      }
    }
    return observed.parsed!
  }

  function onlyPlannedPayloads(observed: ReturnType<typeof observe>) {
    const lock = observed.parsed!
    const native = Object.entries(lock.packages).filter(([, entry]) => entry.source === 'pantry')
    for (const required of ['facebook.com/zstd', 'lz4.org', 'tukaani.org/xz', 'zlib.net']) {
      expect(native.filter(([, entry]) => entry.name === required)).toHaveLength(1)
    }
    const planned = new Set(native.map(([, entry]) => `${entry.name}@${entry.version}`))
    for (const [key, entry] of native) expect(key).toBe(`${entry.name}@${entry.version}`)
    // Inventory comes from both real stores, independently of lock contents.
    // Foreign pins may have no local payload, but every discovered pair needs
    // a normally generated native record, including an unexpected domain.
    for (const [store, domains] of Object.entries(observed.inventory)) {
      for (const [domain, versions] of Object.entries(domains)) {
        for (const version of versions) expect(planned.has(`${domain}@${version}`), `${store}: ${domain}@${version}`).toBe(true)
      }
    }
    for (const [domain, version] of [['lz4.org', '1.10.0'], ['facebook.com/zstd', '1.5.7']]) {
      const records = Object.entries(lock.packages).filter(([, entry]) => entry.name === domain)
      expect(records).toHaveLength(1)
      expect(records[0][0]).toBe(`${domain}@${version}`)
      expect(records[0][1]).toMatchObject({ name: domain, version, source: 'pantry' })
      expect(observed.inventory.project[domain]).toEqual([version])
      expect((observed.inventory.global[domain] ?? []).every(value => value === version)).toBe(true)
    }
  }

  function clearPrivatePayloads() {
    // Simulate a fresh checkout/cache restore without touching generated locks,
    // authored declarations, metadata, archives, or another installation.
    rmSync(join(root, 'pantry'), { recursive: true, force: true })
    rmSync(globalPackages, { recursive: true, force: true })
  }

  return { root, lockPath, globalPackages, observe, success, onlyPlannedPayloads, clearPrivatePayloads }
}

describe.skipIf(!binary)('source CLI named native plan', () => {
  for (const reverse of [false, true]) {
    it(`collects the real zstd child constraint and named lz4 range before payload, reverse=${reverse}`, () => {
      const f = fixture()
      let passed = false
      try {
        const seed = f.observe('seed-empty-workspace', ['install', ...flags], false)
        const before = f.success(seed, false)
        const pair = ['facebook.com/zstd@1.5.7', 'lz4.org@~1.10']
        if (reverse) pair.reverse()
        const observed = f.observe('named-pair', ['install', ...pair, ...flags])
        const after = f.success(observed)
        f.onlyPlannedPayloads(observed)
        for (const [key, entry] of Object.entries(before.packages)) expect(after.packages[key]).toEqual(entry)
        const expectedWorkspaces = structuredClone(before.workspaces)
        expectedWorkspaces[''].system = { ...expectedWorkspaces[''].system, 'lz4.org': '^1.10.0', 'facebook.com/zstd': '^1.5.7' }
        expect(after.workspaces).toEqual(expectedWorkspaces)
        const declarations = readFileSync(join(f.root, 'deps.yaml'), 'utf8')
        expect(declarations.match(/^  lz4\.org: \^1\.10\.0$/gm)).toHaveLength(1)
        expect(declarations.match(/^  facebook\.com\/zstd: \^1\.5\.7$/gm)).toHaveLength(1)
        passed = true
      }
      finally {
        if (passed) rmSync(f.root, { recursive: true, force: true })
        else process.stdout.write(`Named sibling plan evidence retained: ${f.root}\n`)
      }
    }, 60_000)
  }

  it('retains a normally generated native pin for a broad named range on fresh normal and frozen payloads', () => {
    const f = fixture(exactDeclarations)
    let passed = false
    try {
      const seed = f.observe('seed-exact', ['install', ...flags])
      f.success(seed)
      f.onlyPlannedPayloads(seed)
      expect(seed.parsed!.workspaces[''].system).toMatchObject({ 'lz4.org': '1.10.0', 'facebook.com/zstd': '1.5.7' })
      const manifest = readFileSync(join(f.root, 'package.json'), 'utf8')
      for (const frozen of [false, true]) {
        f.clearPrivatePayloads()
        const observed = f.observe(frozen ? 'named-frozen' : 'named-normal', [
          'install', 'facebook.com/zstd@1.5.7', 'lz4.org@^1', ...flags, '--no-save', ...(frozen ? ['--frozen-lockfile'] : []),
        ])
        f.success(observed)
        f.onlyPlannedPayloads(observed)
        expect(observed.text).toBe(seed.text)
        expect(observed.parsed).toEqual(seed.parsed)
        expect(readFileSync(join(f.root, 'deps.yaml'), 'utf8')).toBe(exactDeclarations)
        expect(readFileSync(join(f.root, 'package.json'), 'utf8')).toBe(manifest)
      }
      passed = true
    }
    finally {
      if (passed) rmSync(f.root, { recursive: true, force: true })
      else process.stdout.write(`Named compatible-pin evidence retained: ${f.root}\n`)
    }
  }, 60_000)

  it('rejects incompatible frozen named coverage before any native payload is restored', () => {
    const f = fixture(exactDeclarations)
    let passed = false
    try {
      const seed = f.observe('seed-exact', ['install', ...flags])
      f.success(seed)
      f.onlyPlannedPayloads(seed)
      f.clearPrivatePayloads()
      const observed = f.observe('named-frozen-incompatible', [
        'install', 'facebook.com/zstd@1.5.7', 'lz4.org@^2', ...flags, '--frozen-lockfile', '--no-save',
      ], false)
      if (observed.result.error) throw observed.result.error
      expect(observed.result.signal).toBeNull()
      expect(observed.result.status).toBe(1)
      expect(observed.result.stdout + observed.result.stderr).toContain('lockfile is out of date')
      expect(observed.text).toBe(seed.text)
      expect(readFileSync(join(f.root, 'deps.yaml'), 'utf8')).toBe(exactDeclarations)
      expect(existsSync(join(f.root, 'pantry'))).toBe(false)
      expect(existsSync(f.globalPackages)).toBe(false)
      expect(observed.inventoryErrors).toEqual([])
      expect(observed.inventory.project).toEqual({})
      expect(observed.inventory.global).toEqual({})
      passed = true
    }
    finally {
      if (passed) rmSync(f.root, { recursive: true, force: true })
      else process.stdout.write(`Named frozen preflight evidence retained: ${f.root}\n`)
    }
  }, 60_000)
})
