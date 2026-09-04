import { describe, expect, it } from 'bun:test'
import { packageDomain, packageVersions, versionsChanged } from './changed-package-domains'

const metadata = (versions: string[]) => `export default {
  name: 'Bun',
  domain: 'bun.com',
  versions: [
    ${versions.map(version => `'${version}',`).join('\n    ')}
  ] as const,
}`

describe('changed package domain detection', () => {
  it('reads the declared domain', () => {
    expect(packageDomain(metadata(['1.4.1']))).toBe('bun.com')
  })

  it('reads multiline version arrays', () => {
    expect(packageVersions(metadata(['1.4.1', '1.4.0']))).toEqual(['1.4.1', '1.4.0'])
  })

  it('detects changes inside a multiline version array', () => {
    expect(versionsChanged(metadata(['1.4.0']), metadata(['1.4.1', '1.4.0']))).toBe(true)
  })

  it('ignores cosmetic metadata changes', () => {
    const before = metadata(['1.4.1']).replace("name: 'Bun'", "name: 'bun'")
    expect(versionsChanged(before, metadata(['1.4.1']))).toBe(false)
  })
})
