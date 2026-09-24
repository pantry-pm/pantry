import { describe, expect, it } from 'bun:test'
import { publicBinaryMetadata, sortVersionsNewestFirst } from './binary-publishing'
import {
  isCompleteBinaryRecord,
  isPrereleaseVersion,
  latestPublishedVersion,
  pickLatestVersion,
  preferAsLatest,
} from './version-precedence'

/**
 * `latestVersion` is what `pantry install <pkg>` resolves to, so getting this
 * wrong ships a release candidate to everyone. perl.org did exactly that: it
 * served `latestVersion: 5.44.0-RC2` with 5.44.0 published alongside, because
 * the old comparison split on [.+_-], hit Number('RC2') as non-finite at the
 * fourth component, and fell through to a lexical compare where 'RC2' > ''.
 */
describe('version precedence', () => {
  it('ranks a release above its own release candidate', () => {
    expect(sortVersionsNewestFirst(['5.44.0-RC2', '5.44.0', '5.44.0-RC1'])[0]).toBe('5.44.0')
  })

  it('still prefers a higher numeric version over a lower release', () => {
    expect(sortVersionsNewestFirst(['5.44.0-RC2', '5.42.3'])[0]).toBe('5.44.0-RC2')
  })

  it('picks the newest prerelease when only prereleases exist', () => {
    expect(sortVersionsNewestFirst(['5.44.0-RC1', '5.44.0-RC2'])[0]).toBe('5.44.0-RC2')
  })

  it('orders numerically, not lexically', () => {
    expect(sortVersionsNewestFirst(['1.9.4', '1.10.0', '1.9.10'])).toEqual(['1.10.0', '1.9.10', '1.9.4'])
  })

  it('handles the real perl.org published set', () => {
    const published = ['5.42.0', '5.42.1', '5.42.2', '5.42.3', '5.42.3-RC1', '5.44.0', '5.44.0-RC1', '5.44.0-RC2']
    expect(sortVersionsNewestFirst(published)[0]).toBe('5.44.0')
  })

  it('treats build/underscore separators as prerelease tails too', () => {
    expect(sortVersionsNewestFirst(['3.6.1_beta', '3.6.1'])[0]).toBe('3.6.1')
  })
})

/**
 * latestVersion is re-derived from the published set on every publish, so a
 * pointer left wrong by the old comparison repairs itself the next time
 * anything publishes to that package — rather than needing someone to notice
 * and republish the newest release by hand.
 */
describe('latestVersion re-derivation', () => {
  const latestOf = (versions: string[]) => sortVersionsNewestFirst(versions).at(0)

  it('repairs a pointer stuck on a release candidate', () => {
    expect(latestOf(['5.42.1', '5.44.0', '5.44.0-RC1', '5.44.0-RC2'])).toBe('5.44.0')
  })

  it('does not let a backfilled old version become latest', () => {
    expect(latestOf(['1.0.0', '2.0.0', '0.9.0'])).toBe('2.0.0')
  })
})

/**
 * libgeos.org publishes its prereleases with no dash — `3.15.0beta1`,
 * `3.15.0rc1` — which every comparison that split on `-` read as plain 3.15.0.
 * They tied with the real release, the first one written kept the pointer, and
 * `latestVersion` sat on `3.15.0rc1` with 3.15.0 published beside it.
 */
describe('prereleases written without a dash', () => {
  it('recognizes the tags', () => {
    for (const v of ['3.15.0beta1', '3.15.0rc1', '3.15.0RC1', '2.0.0alpha', '1.0pre3', '3.6.1_beta', '5.44.0-RC2'])
      expect(isPrereleaseVersion(v)).toBe(true)
    for (const v of ['3.15.0', '1.1.1w', '9.9p1', '1.2.3+build.5', 'v2.4'])
      expect(isPrereleaseVersion(v)).toBe(false)
  })

  it('ranks the release above them and orders them among themselves', () => {
    expect(sortVersionsNewestFirst(['3.15.0beta1', '3.15.0rc1', '3.15.0', '3.15.0beta2', '3.14.1']))
      .toEqual(['3.15.0', '3.15.0rc1', '3.15.0beta2', '3.15.0beta1', '3.14.1'])
  })

  it('keeps openssl letter releases in order', () => {
    expect(sortVersionsNewestFirst(['1.1.1v', '1.1.1', '1.1.1w'])).toEqual(['1.1.1w', '1.1.1v', '1.1.1'])
  })
})

/**
 * "latest" is the newest STABLE release: a higher-numbered prerelease is newer,
 * but it is not what someone who named no version asked for.
 */
describe('latest selection', () => {
  it('prefers the newest stable release over a newer prerelease', () => {
    expect(pickLatestVersion(['3.14.0', '3.14.1', '3.15.0beta1', '3.15.0rc1'])).toBe('3.14.1')
    expect(pickLatestVersion(['5.42.3', '5.44.0-RC2'])).toBe('5.42.3')
  })

  it('falls back to the newest prerelease when nothing stable exists', () => {
    expect(pickLatestVersion(['2.0.0beta3', '2.0.0rc1', '2.0.0alpha1'])).toBe('2.0.0rc1')
  })

  it('ratchets a stored pointer the same way', () => {
    expect(preferAsLatest('3.15.0', '3.15.0beta2')).toBe(true)
    expect(preferAsLatest('3.14.1', '3.15.0beta2')).toBe(true)
    expect(preferAsLatest('3.16.0rc1', '3.15.0')).toBe(false)
    expect(preferAsLatest('3.15.1', '3.15.0')).toBe(true)
    expect(preferAsLatest('3.14.9', '3.15.0')).toBe(false)
    expect(preferAsLatest('1.0.0', '')).toBe(true)
  })
})

/**
 * The pkgx fallback advertises versions it can fetch on demand as records with
 * an empty sha256 and a zero size. python.org carried 3.14.7 that way while
 * 3.14.6 was the newest real upload; a stub must not become latest.
 */
describe('latestPublishedVersion', () => {
  const complete = { tarball: 't', sha256: 'a'.repeat(64), size: 10, uploadedAt: '2026-06-11T10:19:01.088Z' }
  const stub = { tarball: 't', sha256: '', size: 0, uploadedAt: '' }

  it('ignores versions whose every platform is a stub', () => {
    expect(latestPublishedVersion({
      '3.14.5': { platforms: { 'linux-x86-64': complete } },
      '3.14.6': { platforms: { 'linux-x86-64': complete } },
      '3.14.7': { platforms: { 'linux-x86-64': stub, 'darwin-arm64': stub } },
    })).toBe('3.14.6')
  })

  it('counts a version once any platform is complete', () => {
    expect(latestPublishedVersion({
      '3.14.6': { platforms: { 'linux-x86-64': complete } },
      '3.14.7': { platforms: { 'linux-x86-64': complete, 'darwin-arm64': stub } },
    })).toBe('3.14.7')
  })

  it('skips prereleases', () => {
    expect(latestPublishedVersion({
      '3.14.1': { platforms: { 'linux-x86-64': complete } },
      '3.15.0rc1': { platforms: { 'linux-x86-64': complete } },
    })).toBe('3.14.1')
  })

  it('still answers when nothing is complete', () => {
    expect(latestPublishedVersion({ '1.0.0': { platforms: { 'linux-x86-64': stub } } })).toBe('1.0.0')
    expect(latestPublishedVersion({})).toBeUndefined()
  })

  it('isCompleteBinaryRecord needs a checksum and a size', () => {
    expect(isCompleteBinaryRecord(complete)).toBe(true)
    expect(isCompleteBinaryRecord(stub)).toBe(false)
    expect(isCompleteBinaryRecord({ ...complete, size: 0 })).toBe(false)
    expect(isCompleteBinaryRecord({ ...complete, sha256: '' })).toBe(false)
    expect(isCompleteBinaryRecord(null)).toBe(false)
  })
})

describe('served binary metadata', () => {
  it('re-derives a stored pointer that sits on a prerelease', () => {
    const record = { tarball: 't', sha256: 'a'.repeat(64), size: 10, uploadedAt: 'x', malwareScan: {} as never }
    const served = publicBinaryMetadata({
      name: 'libgeos.org',
      latestVersion: '3.15.0rc1',
      updatedAt: 'x',
      versions: {
        '3.15.0': { platforms: { 'linux-x86-64': record } },
        '3.15.0rc1': { platforms: { 'linux-x86-64': record } },
        '3.15.0beta1': { platforms: { 'linux-x86-64': record } },
      },
    })
    expect(served.latestVersion).toBe('3.15.0')
  })
})
