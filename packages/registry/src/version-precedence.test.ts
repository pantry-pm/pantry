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
