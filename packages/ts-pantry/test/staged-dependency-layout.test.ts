import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { linkInstalledVersionAlias } from '../scripts/build-package'

test('a staged dependency also answers at its installed v<version> path', () => {
  const deps = mkdtempSync(join(tmpdir(), 'pantry-staged-deps-'))
  try {
    // python.org 3.11.16 (darwin) loads @loader_path/../../v3.11.16/lib/libpython3.11.dylib
    mkdirSync(join(deps, 'python.org/3.11.16/bin'), { recursive: true })
    mkdirSync(join(deps, 'python.org/3.11.16/lib'), { recursive: true })
    writeFileSync(join(deps, 'python.org/3.11.16/lib/libpython3.11.dylib'), '')
    linkInstalledVersionAlias(deps, 'python.org', '3.11.16')
    expect(readlinkSync(join(deps, 'python.org/v3.11.16'))).toBe('3.11.16')
    expect(existsSync(join(deps, 'python.org/3.11.16/bin/../../v3.11.16/lib/libpython3.11.dylib'))).toBe(true)
    // Idempotent, and nested domains work the same way.
    linkInstalledVersionAlias(deps, 'python.org', '3.11.16')
    mkdirSync(join(deps, 'gnome.org/glib/2.88.0'), { recursive: true })
    linkInstalledVersionAlias(deps, 'gnome.org/glib', '2.88.0')
    expect(readlinkSync(join(deps, 'gnome.org/glib/v2.88.0'))).toBe('2.88.0')
  }
  finally { rmSync(deps, { recursive: true, force: true }) }
})

test('pkgx range directories (v<major>, v<major>.<minor>) name the newest staged version', () => {
  const deps = mkdtempSync(join(tmpdir(), 'pantry-staged-deps-'))
  try {
    // libzip.org 1.12.1 (darwin, from pkgx) loads @rpath/zlib.net/v1/lib/libz.dylib
    mkdirSync(join(deps, 'zlib.net/1.4/lib'), { recursive: true })
    writeFileSync(join(deps, 'zlib.net/1.4/lib/libz.dylib'), '')
    linkInstalledVersionAlias(deps, 'zlib.net', '1.4')
    expect(readlinkSync(join(deps, 'zlib.net/v1'))).toBe('1.4')
    expect(existsSync(join(deps, 'zlib.net/v1/lib/libz.dylib'))).toBe(true)

    // Two staged versions of one major: the range follows the newest, and the
    // exact aliases stay put whichever order they arrive in.
    for (const version of ['2.15.4', '2.13.9']) {
      mkdirSync(join(deps, 'gnome.org/libxml2', version), { recursive: true })
      linkInstalledVersionAlias(deps, 'gnome.org/libxml2', version)
    }
    expect(readlinkSync(join(deps, 'gnome.org/libxml2/v2'))).toBe('2.15.4')
    expect(readlinkSync(join(deps, 'gnome.org/libxml2/v2.13'))).toBe('2.13.9')
    expect(readlinkSync(join(deps, 'gnome.org/libxml2/v2.13.9'))).toBe('2.13.9')
    expect(readlinkSync(join(deps, 'gnome.org/libxml2/v2.15.4'))).toBe('2.15.4')

    // A Pantry revision answers for the upstream release it rebuilt
    // (pkgx's readline consumers name v8.3.0; Pantry stages 8.3.0.1).
    mkdirSync(join(deps, 'gnu.org/readline/8.3.0.1'), { recursive: true })
    linkInstalledVersionAlias(deps, 'gnu.org/readline', '8.3.0.1')
    expect(readlinkSync(join(deps, 'gnu.org/readline/v8.3.0'))).toBe('8.3.0.1')

    // 10 sorts after 9 numerically, not lexically.
    for (const version of ['1.9.0', '1.10.0']) {
      mkdirSync(join(deps, 'example.com/tool', version), { recursive: true })
      linkInstalledVersionAlias(deps, 'example.com/tool', version)
    }
    expect(readlinkSync(join(deps, 'example.com/tool/v1'))).toBe('1.10.0')
  }
  finally { rmSync(deps, { recursive: true, force: true }) }
})
