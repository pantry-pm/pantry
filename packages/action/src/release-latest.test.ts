import { describe, expect, it } from 'bun:test'
import { normalizeReleaseMakeLatest, resolveSemanticMakeLatest } from './release-latest'

describe('normalizeReleaseMakeLatest', () => {
  it('defaults to automatic semantic ordering', () => {
    expect(normalizeReleaseMakeLatest('')).toBe('auto')
    expect(normalizeReleaseMakeLatest('AUTO')).toBe('auto')
  })

  it('accepts every GitHub make_latest value', () => {
    expect(normalizeReleaseMakeLatest('true')).toBe('true')
    expect(normalizeReleaseMakeLatest('false')).toBe('false')
    expect(normalizeReleaseMakeLatest('legacy')).toBe('legacy')
  })

  it('rejects invalid values', () => {
    expect(() => normalizeReleaseMakeLatest('yes')).toThrow('release-make-latest')
  })
})

describe('resolveSemanticMakeLatest', () => {
  it('marks only the highest stable repository tag as latest', () => {
    const tags = ['v0.1.0', 'v0.1.1', 'v0.1.2', 'v0.2.0']
    expect(resolveSemanticMakeLatest('v0.1.2', tags, 'auto')).toBe('false')
    expect(resolveSemanticMakeLatest('v0.2.0', tags, 'auto')).toBe('true')
  })

  it('compares numeric semver components', () => {
    expect(resolveSemanticMakeLatest('v0.10.0', ['v0.9.9', 'v0.10.0'], 'auto')).toBe('true')
    expect(resolveSemanticMakeLatest('v0.9.9', ['v0.9.9', 'v0.10.0'], 'auto')).toBe('false')
  })

  it('never marks prereleases as latest automatically', () => {
    expect(resolveSemanticMakeLatest('v1.0.0-beta.1', ['v0.9.0'], 'auto', true)).toBe('false')
  })

  it('uses GitHub legacy behavior for non-semver tags', () => {
    expect(resolveSemanticMakeLatest('nightly', ['nightly'], 'auto')).toBe('legacy')
  })

  it('honors explicit overrides', () => {
    expect(resolveSemanticMakeLatest('v0.1.0', ['v9.0.0'], 'true')).toBe('true')
    expect(resolveSemanticMakeLatest('v9.0.0', ['v0.1.0'], 'false')).toBe('false')
    expect(resolveSemanticMakeLatest('v9.0.0', ['v0.1.0'], 'legacy')).toBe('legacy')
  })
})
