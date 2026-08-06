import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { providerEndpoint, resolveStorageProvider } from './provider'

const KEYS = [
  'STORAGE_PROVIDER',
  'OBJECT_STORAGE_PROVIDER',
  'S3_REGION',
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  'S3_ENDPOINT',
  'S3_FORCE_PATH_STYLE',
  'S3_CDN_BASE_URL',
  'STORAGE_CDN_BASE_URL',
  'R2_ACCOUNT_ID',
  'CLOUDFLARE_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
]

describe('storage provider resolution', () => {
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const key of KEYS) {
      saved[key] = process.env[key]
      delete process.env[key]
    }
  })

  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  })

  it('defaults to AWS with no CDN origin', () => {
    const resolved = resolveStorageProvider()
    expect(resolved.provider).toBe('aws')
    expect(resolved.cdnBaseUrl).toBeUndefined()
  })

  it('resolves R2 to its account-scoped endpoint with path-style addressing', () => {
    process.env.STORAGE_PROVIDER = 'r2'
    process.env.R2_ACCOUNT_ID = 'abc123'
    const resolved = resolveStorageProvider()

    expect(resolved.region).toBe('auto')
    expect(resolved.endpoint).toBe('abc123.r2.cloudflarestorage.com')
    // Virtual-host addressing 404s on R2, so it must not be opt-in.
    expect(resolved.forcePathStyle).toBe(true)
  })

  it('leaves the R2 endpoint unset when no account id is configured', () => {
    expect(providerEndpoint('r2', 'auto')).toBeUndefined()
  })

  it('prefers R2-specific credentials but accepts the generic ones', () => {
    process.env.STORAGE_PROVIDER = 'r2'
    process.env.R2_ACCESS_KEY_ID = 'r2-key'
    process.env.R2_SECRET_ACCESS_KEY = 'r2-secret'
    process.env.S3_ACCESS_KEY_ID = 'generic-key'
    expect(resolveStorageProvider().credentials?.accessKeyId).toBe('r2-key')

    delete process.env.R2_ACCESS_KEY_ID
    delete process.env.R2_SECRET_ACCESS_KEY
    process.env.S3_SECRET_ACCESS_KEY = 'generic-secret'
    expect(resolveStorageProvider().credentials?.accessKeyId).toBe('generic-key')
  })

  it('normalises the CDN origin and drops trailing slashes', () => {
    process.env.S3_CDN_BASE_URL = 'https://cdn.pantry.dev/  '.trim()
    expect(resolveStorageProvider().cdnBaseUrl).toBe('https://cdn.pantry.dev')

    process.env.S3_CDN_BASE_URL = 'https://cdn.pantry.dev///'
    expect(resolveStorageProvider().cdnBaseUrl).toBe('https://cdn.pantry.dev')
  })

  it('treats a blank CDN origin as unset', () => {
    process.env.S3_CDN_BASE_URL = '   '
    expect(resolveStorageProvider().cdnBaseUrl).toBeUndefined()
  })

  it('keeps existing providers unchanged', () => {
    process.env.STORAGE_PROVIDER = 'hetzner'
    process.env.S3_REGION = 'fsn1'
    const resolved = resolveStorageProvider()
    expect(resolved.endpoint).toBe('fsn1.your-objectstorage.com')
    expect(resolved.forcePathStyle).toBe(false)
  })
})
