import { describe, expect, it } from 'bun:test'
import { curlPackage } from '../src/packages/curlse'
import { recipe } from '../src/recipes/curl.se'
import { recipe as ssl3 } from '../src/recipes/curl.se/ssl3'
import { loadRecipe } from '../scripts/recipe-loader'
import { versionSatisfies } from '../scripts/build-package'
import { curlsessl3Package } from '../src/packages/curl.se/ssl3'

describe('curl recipe dependencies', () => {
  it('discovers current releases from upstream curl tags', () => {
    expect(recipe.versionSource?.type).toBe('github-releases')
    if (recipe.versionSource?.type !== 'github-releases')
      throw new Error('curl must discover versions from GitHub releases')

    const match = 'curl-8_22_0'.match(recipe.versionSource.tagPattern!)
    expect(match?.slice(1).join('.')).toBe('8.22.0')
  })

  it('uses the OpenSSL ABI declared by the package metadata', () => {
    expect(recipe.dependencies?.['openssl.org']).toBe('^3')
    expect(curlPackage.dependencies).toContain('openssl.org^3')
  })

  it('builds the Pantry recipe instead of mirroring pkgx OpenSSL 1.1 binaries', async () => {
    const source = await Bun.file(
      new URL('../scripts/build-all-packages.ts', import.meta.url).pathname,
    ).text()
    const customBuilds = source.slice(
      source.indexOf('const CUSTOM_BUILD_DOMAINS'),
      source.indexOf('// Map our platform string'),
    )

    expect(customBuilds).toContain(`'curl.se'`)
  })

  it('delegates runtime ownership to the generic native bundler and tests without injected loader paths', () => {
    // Recipe-level copies lose the canonical owner and become conflicting
    // providers when a downstream closure also contains the original package.
    expect(recipe.build.script).toEqual(['./configure $ARGS', 'make --jobs {{hw.concurrency}} install'])
    for (const domain of ['openssl.org', 'zlib.net', 'nghttp2.org', 'gnu.org/libidn2', 'github.com/google/brotli', 'facebook.com/zstd'])
      expect(recipe.dependencies?.[domain]).toBeString()
    expect(recipe.test?.required).toBe(true)
    expect(recipe.test?.script).toContain('env -u LD_LIBRARY_PATH -u DYLD_LIBRARY_PATH -u DYLD_FALLBACK_LIBRARY_PATH {{prefix}}/bin/curl --version')
  })

  it('the historical OpenSSL 3 domain declares the full runtime closure and checks its own binary', async () => {
    const loaded = await loadRecipe('curl.se/ssl3', 'linux-x86-64', '8.23.0')
    for (const domain of ['facebook.com/zstd', 'github.com/google/brotli', 'gnu.org/libidn2'])
      expect(loaded.recipe.dependencies?.[domain]).toBe(recipe.dependencies?.[domain])
    expect(loaded.recipe.dependencies?.['openssl.org']).toBe('^3')
    expect(ssl3.programs).toEqual([])
    expect(loaded.recipe.test?.required).toBe(true)
    expect(loaded.recipe.test?.script).toEqual(recipe.test?.script)
  })

  it('preserves its required health check through recipe normalization', async () => {
    const loaded = await loadRecipe('curl.se')

    expect(loaded.recipe.test?.required).toBe(true)
  })

  it('both curl identities preserve the accepted archive while publishing owned runtime revisions', async () => {
    for (const domain of ['curl.se', 'curl.se/ssl3']) {
      const loaded = await loadRecipe(domain, 'darwin-arm64', '8.23.0.3')
      expect(loaded.upstreamVersion).toBe('8.23.0')
      expect(loaded.publicationVersion).toBe('8.23.0.3')
      expect(loaded.requiresRecipeBuild).toBe(true)
      expect(loaded.recipe.test?.required).toBe(true)
    }
    expect(curlPackage.versions).toContain('8.23.0.1')
    expect(curlsessl3Package.versions).toContain('8.23.0.1')
    // 8.23.0.1 and 8.23.0.2 for linux-x86-64 were built on Ubuntu 26.04 and
    // need glibc 2.43; revision 3 is the same recipe built at the 2.39 floor.
    expect(curlPackage.versions).toContain('8.23.0.2')
    expect(curlsessl3Package.versions).toContain('8.23.0.2')
    expect(curlPackage.versions[0]).toBe('8.23.0.3')
    expect(curlsessl3Package.versions[0]).toBe('8.23.0.3')
  })

  it('requires the corrected IDN runtime rather than silently selecting the unrecorded older artifact', () => {
    const constraint = recipe.dependencies!['gnu.org/libidn2'] as string
    expect(versionSatisfies('2.3.8', constraint)).toBe(false)
    expect(versionSatisfies('2.3.8.1', constraint)).toBe(false)
    expect(versionSatisfies('2.3.8.2', constraint)).toBe(true)
    for (const metadata of [curlPackage, curlsessl3Package])
      expect(metadata.dependencies).toContain('gnu.org/libidn2^2.3.8.2')
  })

  it('requires the portable Brotli and Zstd source builds', () => {
    for (const [domain, old, current] of [
      ['github.com/google/brotli', '1.2.0', '1.2.0.1'],
      ['facebook.com/zstd', '1.5.7.1', '1.5.7.2'],
    ]) {
      const constraint = recipe.dependencies![domain] as string
      expect(versionSatisfies(old, constraint)).toBe(false)
      expect(versionSatisfies(current, constraint)).toBe(true)
      for (const metadata of [curlPackage, curlsessl3Package])
        expect(metadata.dependencies.some(spec => spec === `${domain}^${current}`)).toBe(true)
    }
  })
})
