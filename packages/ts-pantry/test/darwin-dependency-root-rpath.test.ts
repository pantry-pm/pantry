import { expect, test } from 'bun:test'
import { dependencyInstallRoot, generateBuildScript } from '../scripts/buildkit'

// Dependencies are staged as <deps>/<domain>/<version> beside a v<version>
// alias. Artifacts mirrored from pkgx name their libraries relative to <deps>
// (openssl.org 3.6.5: @rpath/openssl.org/v3.6.5/lib/libssl.3.dylib), so a
// darwin configure probe that links one runs only if <deps> is an rpath too.
// Without it PHP's iconv errno probe aborted in dyld and configure stopped
// with "The iconv check failed, 'errno' is missing".
const deps = '/tmp/pantry-runner/buildkit-deps-php.net'
const depPaths: Record<string, string> = {
  'deps.openssl.org.prefix': `${deps}/openssl.org/3.6.5`,
  'deps.openssl.org.version': '3.6.5',
  'deps.gnu.org/libiconv.prefix': `${deps}/gnu.org/libiconv/1.19.0.2`,
  'deps.gnu.org/libiconv.version': '1.19.0.2',
  'deps.openssl.org@1.1.1w.prefix': `${deps}/openssl.org/1.1.1w`,
  'deps.openssl.org@1.1.1w.version': '1.1.1w',
  'build-tools.gnu.org/libtool:gnu.org/libtool.prefix': `${deps}/.build-tools/gnu.org/libtool/gnu.org/libtool/2.5.4`,
  'build-tools.gnu.org/libtool:gnu.org/libtool.version': '2.5.4',
}

test('the dependency root is derived from <root>/<domain>/<version> prefixes only', () => {
  expect(dependencyInstallRoot('deps.openssl.org.prefix', depPaths['deps.openssl.org.prefix'], depPaths)).toBe(deps)
  expect(dependencyInstallRoot('deps.gnu.org/libiconv.prefix', depPaths['deps.gnu.org/libiconv.prefix'], depPaths)).toBe(deps)
  expect(dependencyInstallRoot('deps.openssl.org@1.1.1w.prefix', depPaths['deps.openssl.org@1.1.1w.prefix'], depPaths)).toBe(deps)
  expect(dependencyInstallRoot('deps.zlib.net.prefix', '/usr', { 'deps.zlib.net.version': '1.3' })).toBeNull()
  expect(dependencyInstallRoot('deps.zlib.net.prefix', '/x/zlib.net/1.3', {})).toBeNull()
  expect(dependencyInstallRoot('build-tools.a:b.prefix', '/x/b/1', { 'build-tools.a:b.version': '1' })).toBeNull()
})

test('darwin probes get an rpath for the dependency root, once, after the lib dirs', () => {
  const script = generateBuildScript({ build: { script: ['./configure'] } }, 'php.net', '8.5.12', 'darwin-arm64', '/tmp/pantry-runner/buildkit-install-php.net', '/tmp/pantry-runner/buildkit-php.net', depPaths)
  const ldflags = script.split('\n').find(line => line.startsWith('export LDFLAGS="-Wl,-rpath,'))!
  expect(ldflags).toContain(`-Wl,-rpath,${deps}/openssl.org/3.6.5/lib`)
  const root = `-Wl,-rpath,${deps} `
  expect(ldflags.split(root).length - 1).toBe(1)
  expect(ldflags.indexOf(root)).toBeGreaterThan(ldflags.indexOf(`${deps}/openssl.org/3.6.5/lib`))
  // Build tools stay out of the target linker graph.
  expect(ldflags).not.toContain('.build-tools')
})

test('linux and Go builds are unchanged', () => {
  const linux = generateBuildScript({ build: { script: ['./configure'] } }, 'php.net', '8.5.12', 'linux-x86-64', '/p', '/b', depPaths)
  expect(linux).not.toContain(`-Wl,-rpath,${deps} `)
  const go = generateBuildScript({ build: { script: ['go build ./...'] } }, 'example.com/tool', '1.0.0', 'darwin-arm64', '/p', '/b', {
    ...depPaths,
    'deps.go.dev.prefix': `${deps}/go.dev/1.26.0`,
    'deps.go.dev.version': '1.26.0',
  })
  expect(go).not.toContain(`-Wl,-rpath,${deps}`)
})
