import { describe, expect, it } from 'bun:test'
import { curlPackage } from '../src/packages/curlse'
import { recipe } from '../src/recipes/curl.se'

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

  it('bundles its Linux runtime libraries and tests without library path injection', () => {
    const linuxStep = recipe.build.script.find(step => typeof step === 'object' && step.if === 'linux')

    expect(linuxStep).toBeDefined()
    expect(JSON.stringify(linuxStep)).toContain('libssl.so.3')
    expect(JSON.stringify(linuxStep)).toContain('libcrypto.so.3')
    expect(recipe.test?.required).toBe(true)
    expect(recipe.test?.script).toContain('env -u LD_LIBRARY_PATH -u DYLD_FALLBACK_LIBRARY_PATH {{prefix}}/bin/curl --version')
  })
})
