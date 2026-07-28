import { describe, expect, test } from 'bun:test'
import { redisPackage } from '../src/packages/redisio'

describe('Redis runtime metadata', () => {
  test('installs the OpenSSL ABI required by the published Linux binary', () => {
    expect(redisPackage.dependencies).toContain('openssl.org^1.1')
    expect(redisPackage.dependencies).not.toContain('openssl.org^3')
  })
})
