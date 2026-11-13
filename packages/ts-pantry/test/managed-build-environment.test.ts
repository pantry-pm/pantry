import { expect, test } from 'bun:test'
import { generateBuildScript } from '../scripts/buildkit'
import { collectBuildDependencies, externalRuntimePackages } from '../scripts/build-package'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('runtime cycles use the current artifact while retaining different versions and dependencies', () => {
  const self = { domain: 'tukaani.org/xz', version: '5.8.2', prefix: '/old-self' }
  const previous = { domain: 'tukaani.org/xz', version: '5.6.0', prefix: '/previous-ABI' }
  const other = { domain: 'gnu.org/gettext', version: '1.0.0', prefix: '/gettext' }
  const input = [self, previous, other]
  expect(externalRuntimePackages(input, { domain: 'tukaani.org/xz', version: '5.8.2' })).toEqual([previous, other])
  expect(input).toEqual([self, previous, other])
})

test('a native recipe replaces obsolete generated build and runtime dependency edges', () => {
  const metadata = { dependencies: ['retired.example ^1'], buildDependencies: ['github.com/tmux/tmux@^3'] }
  const graph = collectBuildDependencies(metadata, ['gnu.org/make', 'shared.example >=1'], ['shared.example <2'], new Set(), 'linux-x86-64', true)
  expect([...graph]).toEqual([['gnu.org/make', 'gnu.org/make'], ['shared.example', 'shared.example >=1<2']])
  expect(graph.has('retired.example')).toBe(false)
  expect(graph.has('github.com/tmux/tmux')).toBe(false)
})

test('slash-domain build tools use canonical filesystem paths, not URL escapes', async () => {
  const { installBuildDependencyGraphs } = await import('../scripts/build-package')
  const directories: string[] = []
  await installBuildDependencyGraphs(new Map(), new Map([['github.com/westes/flex', 'github.com/westes/flex ^2']]), '/managed',
    async initial => initial,
    async (graph, directory) => {
      directories.push(directory)
      return Object.fromEntries([...graph.keys()].flatMap(domain => [[`deps.${domain}.prefix`, `${directory}/${domain}`], [`deps.${domain}.version`, '2.6.4']]))
    })
  expect(directories).toContain('/managed/.build-tools/github.com/westes/flex')
  expect(directories.join(':')).not.toContain('%')
})

for (const platform of ['linux-x86-64', 'darwin-arm64']) {
  test(`${platform} uses declared dependency library and pkg-config roots`, async () => {
    const script = generateBuildScript({ build: { script: ['true'] } }, 'fixture', '1.0.0', platform, '/tmp/fixture-prefix', '/tmp/fixture-build', {
      'deps.example.org/library.prefix': '/tmp/managed-library',
      'deps.python.org.prefix': '/tmp/managed-python',
    })
    const exports = script.split('\n').filter(line => /^export (PKG_CONFIG_PATH|PKG_CONFIG_LIBDIR|LIBRARY_PATH|C_INCLUDE_PATH|CPLUS_INCLUDE_PATH|LDFLAGS)=/.test(line) || line === 'unset CPATH').join('\n')
    const child = Bun.spawn(['bash', '-ec', `${exports}\nprintf '%s\\n' "$PKG_CONFIG_PATH" "$PKG_CONFIG_LIBDIR" "$LIBRARY_PATH" "$C_INCLUDE_PATH" "$CPLUS_INCLUDE_PATH" "$CPATH" "$LDFLAGS"`], {
      env: { ...process.env, PKG_CONFIG_PATH: '/unmanaged/pc', PKG_CONFIG_LIBDIR: '/unmanaged/pc', LIBRARY_PATH: '/unmanaged/lib', CPATH: '/unmanaged/include' }, stdout: 'pipe', stderr: 'pipe',
    })
    const [status, stdout] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    expect(status).toBe(0)
    expect(stdout).toContain('/tmp/managed-library/lib64/pkgconfig')
    expect(stdout).toContain('/tmp/managed-library/lib64')
    expect(stdout).toContain('-L/tmp/managed-library/lib -L/tmp/managed-library/lib64')
    expect(stdout).not.toContain('/unmanaged')
    expect(stdout).not.toContain('/opt/homebrew')
    expect(stdout).not.toContain('/usr/lib')
    expect(script).not.toContain('SYSLIB_OVERRIDE_EOF')
    expect(script).not.toContain('_CARGO_REAL')
    expect(script).not.toContain('rustup default stable')
    expect(script).not.toContain('sudo rm -rf /usr/lib/python3')
    expect(script).not.toContain('pip install --quiet')
    expect(script).not.toContain('SCRUB_CMAKE_EOF')
    expect(script).not.toContain('BZIP2PC')
  })

  test(`${platform} dependency resolution retains declared readline, Meson and Cargo`, () => {
    const graph = collectBuildDependencies({ dependencies: ['gnu.org/readline ^8'], buildDependencies: ['rust-lang.org/cargo ^1'] }, ['mesonbuild.com ^1'], ['gnu.org/readline >=8<9'])
    expect(graph.get('gnu.org/readline')).toBe('gnu.org/readline >=8<9')
    expect(graph.get('mesonbuild.com')).toBe('mesonbuild.com ^1')
    expect(graph.get('rust-lang.org/cargo')).toBe('rust-lang.org/cargo ^1')
    expect(graph.size).toBe(3)
  })
}

test('the complete runtime closure retains all parent constraints and terminates cycles', async () => {
  const { resolveBuildDependencyGraph } = await import('../scripts/build-package')
  const recipes: Record<string, { dependencies?: Record<string, string>, build?: { dependencies: Record<string, string> } }> = {
    'a.org': { dependencies: { 'b.org': '^1', 'shared.org': '>=1' }, build: { dependencies: { 'unused-compiler.org': '*' } } },
    'b.org': { dependencies: { 'c.org': '^1' } },
    'c.org': { dependencies: { 'd.org': '^1' } },
    'd.org': { dependencies: { 'e.org': '^1', 'shared.org': '<2' } },
    'e.org': { dependencies: { 'a.org': '^1' } },
    'shared.org': {},
  }
  const visited: string[] = []
  const graph = await resolveBuildDependencyGraph(new Map([['a.org', 'a.org ^1']]), 'linux-x86-64', async (domain) => {
    visited.push(domain)
    if (!recipes[domain]) throw new Error('missing recipe')
    return recipes[domain]
  })
  expect(graph.has('e.org')).toBe(true)
  expect(graph.get('shared.org')).toBe('shared.org >=1 <2')
  expect(graph.has('unused-compiler.org')).toBe(false)
  expect(visited.length).toBe(6)
  await expect(resolveBuildDependencyGraph(new Map([['missing.org', 'missing.org ^1']]), 'linux-x86-64', async () => { throw new Error('missing recipe') })).rejects.toThrow('missing recipe')
})

test('recipe build and runtime bounds intersect even when metadata repeats the first bound', () => {
  const graph = collectBuildDependencies({ dependencies: ['shared.org >=1'] }, ['shared.org >=1'], ['shared.org <2'])
  expect(graph.get('shared.org')).toBe('shared.org >=1<2')
})

test('native build graphs filter opposite-platform metadata before resolving runtime packages', () => {
  const metadata = { dependencies: ['zlib.net ^1', 'linux:x.org/x11 ^1', 'darwin:apple.example ^1', 'linux/x86-64:intel.example ^1', 'darwin/arm64:arm.example ^1', 'linux/armv7:armv7.example ^1'] }
  const mac = collectBuildDependencies(metadata, [], ['zlib.net ^1'], new Set(), 'darwin-arm64')
  expect([...mac.keys()]).toEqual(['zlib.net', 'apple.example', 'arm.example'])
  const linux = collectBuildDependencies(metadata, [], ['zlib.net ^1'], new Set(), 'linux-arm64')
  expect([...linux.keys()]).toEqual(['zlib.net', 'x.org/x11'])
  const intel = collectBuildDependencies(metadata, [], ['zlib.net ^1'], new Set(), 'linux-x86-64')
  expect([...intel.keys()]).toEqual(['zlib.net', 'x.org/x11', 'intel.example'])
})

test('a build tool can use XML 2.13 while the target links XML 2.15', async () => {
  const { installBuildDependencyGraphs } = await import('../scripts/build-package')
  const installed = await installBuildDependencyGraphs(new Map([['xml.example', 'xml.example ~2.15']]), new Map([['xml.example', 'xml.example ~2.15'], ['gettext.example', 'gettext.example ^1']]), '/managed',
    async (initial) => {
      const graph = new Map(initial)
      if (graph.has('gettext.example')) graph.set('xml.example', 'xml.example ~2.13')
      return graph
    },
    async (graph, directory) => Object.fromEntries([...graph].flatMap(([domain, spec]) => [[`deps.${domain}.prefix`, `${directory}/${domain}`], [`deps.${domain}.version`, spec.includes('2.13') ? '2.13.9' : '2.15.4']])))
  expect(installed.runtimePackages.map(pkg => `${pkg.domain}@${pkg.version}`)).toEqual(['xml.example@2.15.4'])
  const script = generateBuildScript({ build: { script: ['true'] } }, 'fixture', '1.0.0', 'linux-x86-64', '/artifact', '/build', installed.depPaths)
  const exports = script.split('\n').filter(line => /^export (PATH|PKG_CONFIG_PATH|LIBRARY_PATH|C_INCLUDE_PATH)=/.test(line) || line === 'unset CPATH').join('\n')
  const child = Bun.spawnSync(['bash', '-ec', `${exports}\nprintf '%s\\n' "$PATH" "$PKG_CONFIG_PATH" "$LIBRARY_PATH" "$C_INCLUDE_PATH"`], { env: { PATH: '/usr/bin:/bin' }, stdout: 'pipe', stderr: 'pipe' })
  expect(child.exitCode, child.stderr.toString()).toBe(0)
  const [bins, pc, libs, headers] = child.stdout.toString().trim().split('\n')
  expect(bins).toContain('/.build-tools/gettext.example/xml.example/bin')
  for (const value of [pc, libs, headers]) {
    expect(value).toContain('/managed/xml.example')
    expect(value).not.toContain('/.build-tools/gettext.example/xml.example')
  }
})

test.skipIf(process.platform === 'win32')('a real native build tool loads its declared private ABI while the target links its own ABI', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pantry-build-tool-loader-'))
  const target = join(root, 'target-dependency')
  const tool = join(root, 'build-tool')
  const privateRuntime = join(root, 'private-runtime')
  const compiler: string[] = process.platform === 'darwin' ? ['xcrun', 'clang'] : process.env.PANTRY_TEST_CC ? JSON.parse(process.env.PANTRY_TEST_CC) : ['cc']
  const environment = { ...process.env }
  for (const key of ['LD_LIBRARY_PATH', 'LD_PRELOAD', 'DYLD_LIBRARY_PATH', 'DYLD_FALLBACK_LIBRARY_PATH', 'LIBRARY_PATH', 'LDFLAGS']) delete environment[key]
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  const run = (command: string[]) => {
    const result = Bun.spawnSync(command, { cwd: root, env: environment, stdout: 'pipe', stderr: 'pipe' })
    expect(result.exitCode, result.stderr.toString()).toBe(0)
    return result.stdout.toString().trim()
  }
  try {
    for (const directory of [join(target, 'lib'), join(tool, 'bin'), join(privateRuntime, 'lib64')]) mkdirSync(directory, { recursive: true })
    writeFileSync(join(root, 'main.c'), '#include <stdio.h>\nextern int pantry_fixture(void); int main(void) { printf("%d\\n", pantry_fixture()); }\n')
    for (const [abi, directory] of [[17, join(target, 'lib')], [19, join(privateRuntime, 'lib64')]] as const) {
      const source = join(root, `library-${abi}.c`)
      writeFileSync(source, `int pantry_fixture(void) { return ${abi}; }\n`)
      const name = process.platform === 'darwin' ? `libpantry_fixture.${abi}.dylib` : `libpantry_fixture.so.${abi}`
      run([...compiler, ...(process.platform === 'darwin' ? ['-dynamiclib', '-install_name', name] : ['-shared', '-fPIC', `-Wl,-soname,${name}`]), source, '-o', join(directory, name)])
      symlinkSync(name, join(directory, process.platform === 'darwin' ? 'libpantry_fixture.dylib' : 'libpantry_fixture.so'))
    }
    const executable = join(tool, 'bin/fixture-tool')
    run([...compiler, join(root, 'main.c'), `-L${privateRuntime}/lib64`, '-lpantry_fixture', '-o', executable])
    const missing = Bun.spawnSync([executable], { cwd: root, env: environment, stdout: 'pipe', stderr: 'pipe' })
    expect(missing.exitCode).not.toBe(0)
    expect(missing.stderr.toString()).toContain(process.platform === 'darwin' ? 'libpantry_fixture.19.dylib' : 'libpantry_fixture.so.19')
    const script = generateBuildScript({ build: { script: ['true'] } }, 'fixture', '1.0.0', `${process.platform === 'darwin' ? 'darwin' : 'linux'}-${process.arch === 'arm64' ? 'arm64' : 'x86-64'}`, '/artifact', '/build', {
      'deps.target.example.prefix': target,
      'deps.tool.example.prefix': tool,
      'build-tools.tool.example:private.example.prefix': privateRuntime,
    })
    const exports = script.split('\n').filter(line => /^export (LD_LIBRARY_PATH|DYLD_FALLBACK_LIBRARY_PATH|LIBRARY_PATH|LDFLAGS|CMAKE_PREFIX_PATH|PKG_CONFIG_PATH)=/.test(line))
    const binary = join(root, 'target-consumer')
    const command = `${exports.join('\n')}\n${quote(executable)}\n${compiler.map(quote).join(' ')} ${quote(join(root, 'main.c'))} -lpantry_fixture $LDFLAGS -o ${quote(binary)}\n${quote(binary)}`
    expect(run(['bash', '-ec', command])).toBe('19\n17')
    for (const line of exports.filter(line => !/^export (LD_LIBRARY_PATH|DYLD_FALLBACK_LIBRARY_PATH)=/.test(line))) {
      expect(line).toContain(target)
      expect(line).not.toContain(privateRuntime)
    }
  }
  finally { rmSync(root, { recursive: true, force: true }) }
})
