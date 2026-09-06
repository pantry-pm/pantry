import { describe, expect, it } from 'bun:test'
import { sortVersionsNewestFirst } from './binary-publishing'

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
