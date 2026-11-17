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
