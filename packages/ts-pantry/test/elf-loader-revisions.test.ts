import { describe, expect, test } from 'bun:test'
import { brokenTargets, classifyTarget, orderTargets, planRevision, writePackageVersion, writeRecipeRevision } from '../scripts/elf-loader-revisions'

const recipe = `import type { Recipe } from '../../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'agwa.name/git-crypt',
  name: 'git-crypt',
  programs: [
    'git-crypt',
  ],
}
`

const pkg = `export const p = {
  domain: 'agwa.name/git-crypt' as const,
  versions: [
    '0.8.0',
    '0.7.0',
  ] as const,
}
`

describe('ELF loader-path revisions', () => {
  test('the newest broken Linux artifact per package is the target', () => {
    const finding = { member: './bin/x', value: '/../lib', issues: ['expanded-origin'] }
    const targets = brokenTargets([
      { domain: 'a.org', version: '1.0.0', platform: 'linux-x86-64', newestOnPlatform: true, findings: [finding] },
      { domain: 'a.org', version: '1.0.0', platform: 'linux-arm64', newestOnPlatform: true, findings: [{ ...finding, issues: ['empty'] }] },
      { domain: 'b.org', version: '2.0.0', platform: 'linux-x86-64', newestOnPlatform: false, supersededBy: '2.1.0', findings: [finding] },
      { domain: 'c.org', version: '3.0.0', platform: 'linux-x86-64', newestOnPlatform: true, findings: [] },
      { domain: 'd.org', version: '4.0.0', platform: 'linux-x86-64', newestOnPlatform: true, error: 'inflate failed', findings: [] },
    ])
    expect(targets).toEqual([{ domain: 'a.org', version: '1.0.0', platforms: ['linux-arm64', 'linux-x86-64'], issues: ['empty', 'expanded-origin'], members: ['./bin/x'] }])
  })

  test('the recipe gains the revision and its reason, and the catalog the identity', () => {
    const target = { domain: 'agwa.name/git-crypt', version: '0.8.0', platforms: ['linux-x86-64'], issues: [], members: [] }
    const plan = planRevision(target, recipe, pkg)
    if ('blocked' in plan) throw new Error(plan.blocked)
    expect(plan.revision).toBe('0.8.0.1')
    const revised = writeRecipeRevision(recipe, plan.revisions, '0.8.0')
    expect(revised).toContain(`  name: 'git-crypt',\n  revisions: { '0.8.0': 1 },\n  revisionReasons: { '0.8.0': 'elf-loader-paths' },\n`)
    expect(writePackageVersion(pkg, '0.8.0', '0.8.0.1')).toContain(`    '0.8.0.1',\n    '0.8.0',\n    '0.7.0',`)
    // A second loader-path repair of the same release counts up.
    const again = planRevision(target, revised, writePackageVersion(pkg, '0.8.0', '0.8.0.1'))
    expect('revision' in again && again.revision).toBe('0.8.0.2')
  })

  test('versions that cannot carry a revision, and other repairs, are reported rather than edited', () => {
    const target = { domain: 'x', version: '0.8.0rc1', platforms: [], issues: [], members: [] }
    const prerelease = planRevision(target, recipe, pkg.replace(`'0.8.0',`, `'0.8.0rc1',`))
    expect('revision' in prerelease && prerelease.revision).toBe('0.8.0rc1.pantry1')
    const patched = recipe.replace(`  name: 'git-crypt',`, `  name: 'git-crypt',\n  revisions: { '0.8.0': 1 },`)
    expect('blocked' in planRevision({ ...target, version: '0.8.0' }, patched, pkg)).toBe(true)
  })

  test('core libraries come before everything else, then fan-out', () => {
    const t = (domain: string) => ({ domain, version: '1.0.0', platforms: [], issues: [], members: [] })
    const ordered = orderTargets([t('leaf.dev'), t('zlib.net'), t('lib.org')], new Map([['lib.org', 9]]), () => 0)
    expect(ordered.map(x => x.domain)).toEqual(['zlib.net', 'lib.org', 'leaf.dev'])
  })
})

describe('classifyTarget', () => {
  const target = { domain: 'bore.pub', version: '0.6.0', platforms: ['linux-arm64', 'linux-x86-64'], issues: ['expanded-origin'], members: ['bin/bore'] }
  const row = (platform: string, extra: Record<string, unknown> = {}) => ({
    domain: 'bore.pub',
    version: '0.6.0',
    platform,
    newestOnPlatform: true,
    findings: [{ member: 'bin/bore', value: '/../lib', issues: ['expanded-origin'] }],
    needed: [],
    sharedLibraries: 0,
    ...extra,
  })

  test('a binary needing only host libraries through /../lib is harmless', () => {
    expect(classifyTarget(target, [row('linux-arm64'), row('linux-x86-64')], []).harmless).toBe(true)
  })

  test('anything a broken entry could be searched for keeps the repair', () => {
    expect(classifyTarget(target, [row('linux-arm64', { needed: ['libssl.so.3'] }), row('linux-x86-64')], []))
      .toEqual({ harmless: false, reason: 'needs libssl.so.3' })
    expect(classifyTarget(target, [row('linux-arm64', { sharedLibraries: 2 }), row('linux-x86-64')], []).harmless).toBe(false)
    expect(classifyTarget(target, [row('linux-arm64'), row('linux-x86-64')], ['openssl.org^3']).harmless).toBe(false)
    expect(classifyTarget(target, [row('linux-arm64', { findings: [{ member: 'bin/bore', value: '', issues: ['empty'] }] }), row('linux-x86-64')], []).harmless).toBe(false)
  })

  test('a platform not re-audited, or audited without DT_NEEDED, is not judged', () => {
    expect(classifyTarget(target, [row('linux-arm64')], []).harmless).toBe(false)
    expect(classifyTarget(target, [row('linux-arm64'), row('linux-x86-64', { needed: undefined })], []).harmless).toBe(false)
  })
})
