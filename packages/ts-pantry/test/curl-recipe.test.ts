import { describe, expect, it } from 'bun:test'
import { curlPackage } from '../src/packages/curlse'
import { recipe } from '../src/recipes/curl.se'

describe('curl recipe dependencies', () => {
  it('uses the OpenSSL ABI declared by the package metadata', () => {
    expect(recipe.dependencies?.['openssl.org']).toBe('^3')
    expect(curlPackage.dependencies).toContain('openssl.org^3')
  })
})
