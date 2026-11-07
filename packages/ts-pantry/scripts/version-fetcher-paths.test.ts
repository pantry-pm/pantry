import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findPackageFile } from './version-fetcher'

const directories: string[] = []
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'pantry-version-paths-'))
  directories.push(directory)
  return directory
}
function metadata(path: string, domain: string) { writeFileSync(path, `export const pkg = { domain: '${domain}', versions: ['1.0.0'] as const }`) }
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

describe('version updater catalog lookup', () => {
  it('finds Git using the same preserved hyphen as the catalog generator', () => {
    const directory = fixture()
    const path = join(directory, 'git-scmorg.ts')
    metadata(path, 'git-scm.org')
    expect(findPackageFile('git-scm.org', directory)).toBe(path)
  })
  it('finds a nested provider and application catalog without flattening its name', () => {
    const directory = fixture()
    mkdirSync(join(directory, 'apps'))
    const provider = join(directory, 'agwaname-git-crypt.ts')
    const application = join(directory, 'apps', 'example-com.ts')
    metadata(provider, 'agwa.name/git-crypt')
    metadata(application, 'example-.com')
    expect(findPackageFile('agwa.name/git-crypt', directory)).toBe(provider)
    expect(findPackageFile('example-.com', directory)).toBe(application)
  })
  it('preserves legacy flattened names while refusing a different declared domain', () => {
    const directory = fixture()
    const path = join(directory, 'gitscmorg.ts')
    metadata(path, 'git-scm.org')
    expect(findPackageFile('git-scm.org', directory)).toBe(path)
    metadata(path, 'another.invalid')
    expect(findPackageFile('git-scm.org', directory)).toBeUndefined()
  })
})
