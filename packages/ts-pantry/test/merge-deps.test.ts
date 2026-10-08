import { describe, expect, it } from 'bun:test'
import { mergeDeps } from '../src/generate-zig'

describe('mergeDeps', () => {
  it('lets the build recipe win over a stale upstream pin', () => {
    // The registry built ffmpeg against harfbuzz 14; upstream still said ^8,
    // which no registry artifact satisfies.
    expect(mergeDeps(['libsdl.org^2', 'harfbuzz.org^8'], ['harfbuzz.org>=8'])).toEqual(['libsdl.org^2', 'harfbuzz.org>=8'])
    expect(mergeDeps(['openssl.org^1.1.1k'], ['openssl.org^3'])).toEqual(['openssl.org^3'])
  })

  it('keeps metadata-only deps and appends recipe-only ones', () => {
    expect(mergeDeps(['zlib.net^1'], ['postgresql.org^17'])).toEqual(['zlib.net^1', 'postgresql.org^17'])
  })

  it('matches by platform and domain', () => {
    expect(mergeDeps(['linux:x.org/x11', 'darwin:x.org/x11'], ['linux:x.org/x11^1'])).toEqual(['linux:x.org/x11^1', 'darwin:x.org/x11'])
  })
})
