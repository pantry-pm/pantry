import { describe, expect, test } from 'bun:test'
import { parseDep, parseDepConstraint } from './build-package'

describe('dependency spec parsing', () => {
  // The domain and the constraint are read by two different functions. They
  // have to agree on where the domain ends, and they did not: parseDepConstraint
  // understood the space-separated form (`freetype.org 2` → "2") while parseDep
  // left the " 2" on the domain. The lookup then asked S3 for
  // `binaries/freetype.org 2/metadata.json`, got a 404, and reported
  // "not in S3, falling back to system path → /usr" — so ghostscript.com built
  // against a prefix with no freetype in it and failed configure every time.
  const cases: Array<[string, string, string | null]> = [
    ['freetype.org 2', 'freetype.org', '2'],
    ['zlib.net 1', 'zlib.net', '1'],
    ['gnome.org/libxml2 2', 'gnome.org/libxml2', '2'],
    ['python.org 3.11', 'python.org', '3.11'],
    ['freetype.org ^2.13', 'freetype.org', '^2.13'],
    ['freedesktop.org/pkg-config ^0.29', 'freedesktop.org/pkg-config', '^0.29'],
    ['openssl.org@1.1', 'openssl.org', '@1.1'],
    ['nodejs.org~22', 'nodejs.org', '~22'],
    ['curl.se', 'curl.se', null],
    ['linux:zlib.net 1', 'zlib.net', '1'],
    ['darwin:freetype.org ^2.13', 'freetype.org', '^2.13'],
  ]

  for (const [spec, domain, constraint] of cases) {
    test(`splits ${JSON.stringify(spec)}`, () => {
      expect(parseDep(spec)).toBe(domain)
      expect(parseDepConstraint(spec)).toBe(constraint as string)
    })
  }

  test('never leaves whitespace in a domain, which becomes an S3 key', () => {
    for (const [spec] of cases) expect(parseDep(spec)).not.toMatch(/\s/)
  })

  test('a version-shaped domain segment is not mistaken for a constraint', () => {
    // No space, so nothing to strip — the digits are part of the name.
        expect(parseDep('gnome.org/libxml2')).toBe('gnome.org/libxml2')
    expect(parseDep('sourceware.org/bzip2')).toBe('sourceware.org/bzip2')
  })
})
