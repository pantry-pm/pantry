import { describe, expect, test } from 'bun:test'
import { compareVersionsDesc, parseVersion, resolveVersionFromMetadata } from '../src/version-utils'

/**
 * `^0.16.0` used to resolve to `0.17.0`.
 *
 * The caret branch only compared the major, so every 0.x release looked
 * compatible with every other. For zero-major packages that is backwards:
 * semver gives no compatibility promise between 0.x minors, which is why npm
 * treats `^0.16.0` as `>=0.16.0 <0.17.0`.
 *
 * The concrete cost: a project pinning `ziglang.org: ^0.16.0` was handed a
 * 0.17.0-dev toolchain, whose std lib had moved on enough that the project's
 * own `build.zig` no longer compiled. The pin looked right and the build was
 * simply broken.
 */
describe('resolveVersionFromMetadata: caret', () => {
  test('pins the minor for a zero-major constraint', () => {
    const versions = ['0.14.1', '0.15.1', '0.16.0', '0.17.0']
    expect(resolveVersionFromMetadata('^0.16.0', versions)).toBe('0.16.0')
  })

  test('still takes the newest patch within that minor', () => {
    const versions = ['0.16.0', '0.16.3', '0.16.1', '0.17.0']
    expect(resolveVersionFromMetadata('^0.16.0', versions)).toBe('0.16.3')
  })

  test('pins only the major once major is non-zero', () => {
    expect(resolveVersionFromMetadata('^1.2.0', ['1.2.0', '1.3.0', '2.0.0'])).toBe('1.3.0')
    expect(resolveVersionFromMetadata('^17.0.0', ['17.5.0', '17.3.0', '16.4.0'])).toBe('17.5.0')
  })

  test('never selects a version below the constraint', () => {
    expect(resolveVersionFromMetadata('^1.5.0', ['1.4.0', '1.3.0'])).toBeNull()
    expect(resolveVersionFromMetadata('^0.16.2', ['0.16.0', '0.16.1'])).toBeNull()
  })

  test('fails rather than crossing into another major', () => {
    // Silently installing 1.0.0 for `^3.0.0` is worse than reporting no match.
    expect(resolveVersionFromMetadata('^3.0.0', ['1.0.0', '2.0.0'])).toBeNull()
  })
})

describe('resolveVersionFromMetadata: tilde', () => {
  test('pins major.minor', () => {
    expect(resolveVersionFromMetadata('~0.16.0', ['0.16.0', '0.17.0'])).toBe('0.16.0')
    expect(resolveVersionFromMetadata('~1.2.0', ['1.2.9', '1.3.0'])).toBe('1.2.9')
  })

  test('without an explicit patch, any patch in the minor qualifies', () => {
    expect(resolveVersionFromMetadata('~1.2', ['1.2.0', '1.2.9', '1.3.0'])).toBe('1.2.9')
  })

  test('with an explicit patch, stays at or above it', () => {
    expect(resolveVersionFromMetadata('~1.2.5', ['1.2.1', '1.2.9'])).toBe('1.2.9')
    expect(resolveVersionFromMetadata('~1.2.5', ['1.2.1', '1.2.4'])).toBeNull()
  })
})

describe('resolveVersionFromMetadata: prereleases', () => {
  test('a stable range never selects a prerelease', () => {
    // The other half of the Zig regression: `0.17.0-dev.1441` sorted to the top
    // and was handed back for a range that asked for a released version.
    const versions = ['0.16.0', '0.16.1-dev.20', '0.17.0-dev.1441']
    expect(resolveVersionFromMetadata('^0.16.0', versions)).toBe('0.16.0')
  })

  test('a prerelease constraint may select a matching prerelease', () => {
    const versions = ['0.16.0-dev.2', '0.16.0-dev.5', '0.17.0']
    expect(resolveVersionFromMetadata('^0.16.0-dev', versions)).toBe('0.16.0-dev.5')
  })

  test('a prerelease constraint does not unlock unrelated prereleases', () => {
    expect(resolveVersionFromMetadata('^0.16.0-dev', ['0.16.1-dev.9'])).toBeNull()
  })

  test('an exact prerelease still resolves', () => {
    expect(resolveVersionFromMetadata('0.17.0-dev.1441', ['0.16.0', '0.17.0-dev.1441']))
      .toBe('0.17.0-dev.1441')
  })
})

describe('resolveVersionFromMetadata: plain and partial constraints', () => {
  test('an exact version wins', () => {
    expect(resolveVersionFromMetadata('0.16.0', ['0.16.0', '0.17.0'])).toBe('0.16.0')
  })

  test('a partial version takes the newest release under it', () => {
    expect(resolveVersionFromMetadata('0.16', ['0.16.0', '0.16.2', '0.17.0'])).toBe('0.16.2')
    expect(resolveVersionFromMetadata('1', ['1.0.0', '1.9.3', '2.0.0'])).toBe('1.9.3')
  })

  test('a partial version compares components, not string prefixes', () => {
    // `0.1` must not match `0.16.0` the way a startsWith check did.
    expect(resolveVersionFromMetadata('0.1', ['0.16.0', '0.1.4'])).toBe('0.1.4')
  })

  test('returns null for an empty version list', () => {
    expect(resolveVersionFromMetadata('^1.0.0', [])).toBeNull()
  })
})

describe('parseVersion', () => {
  test('splits core, prerelease and build metadata', () => {
    expect(parseVersion('0.17.0-dev.1441+d5181a9c9')).toEqual({
      major: 0,
      minor: 17,
      patch: 0,
      prerelease: ['dev', '1441'],
    })
  })

  test('tolerates a v prefix and a missing patch', () => {
    expect(parseVersion('v1.2')).toEqual({ major: 1, minor: 2, patch: 0, prerelease: [] })
  })

  test('turns junk into 0 rather than NaN', () => {
    // NaN poisons every comparison it reaches, which is how a prerelease could
    // sort above a stable release.
    expect(parseVersion('1.x.3')).toEqual({ major: 1, minor: 0, patch: 3, prerelease: [] })
  })
})

describe('compareVersionsDesc (newest first)', () => {
  test('orders by numeric components', () => {
    expect(compareVersionsDesc('0.17.0', '0.16.0')).toBeLessThan(0)
    expect(compareVersionsDesc('1.2.10', '1.2.9')).toBeLessThan(0)
  })

  test('a release outranks its own prerelease', () => {
    expect(compareVersionsDesc('1.0.0', '1.0.0-rc.1')).toBeLessThan(0)
  })

  test('a newer numeric base wins over a larger prerelease counter', () => {
    expect(compareVersionsDesc('0.17.0-dev.263', '0.16.0-dev.2471')).toBeLessThan(0)
  })

  test('compares prerelease identifiers per semver', () => {
    expect(compareVersionsDesc('1.0.0-rc.2', '1.0.0-rc.10')).toBeGreaterThan(0)
    expect(compareVersionsDesc('1.0.0-beta', '1.0.0-alpha')).toBeLessThan(0)
    // A longer prerelease outranks the prefix it extends.
    expect(compareVersionsDesc('1.0.0-rc.1', '1.0.0-rc')).toBeLessThan(0)
  })

  test('sorts a real Zig release list newest-first', () => {
    const sorted = ['0.16.0', '0.17.0-dev.1441', '0.15.1', '0.17.0'].sort(compareVersionsDesc)
    expect(sorted).toEqual(['0.17.0', '0.17.0-dev.1441', '0.16.0', '0.15.1'])
  })
})
