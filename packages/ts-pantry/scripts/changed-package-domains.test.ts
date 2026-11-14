import { describe, expect, it } from 'bun:test'
import { packageDomain, packageVersions, versionsChanged, parsePublicationResult, PUBLICATION_RESULT_TITLE, publicationResultAnnotation } from './changed-package-domains'

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

it('a publisher job names the packages it could not publish in one annotation that recovery can read back', () => {
  expect(publicationResultAnnotation([])).toBe(`::notice title=${PUBLICATION_RESULT_TITLE}::none`)
  // Once per package, however many of its versions failed, and in a stable order.
  expect(publicationResultAnnotation(['zlib.net', 'github.com/ggerganov/llama.cpp', 'zlib.net']))
    .toBe(`::error title=${PUBLICATION_RESULT_TITLE}::github.com/ggerganov/llama.cpp,zlib.net`)
  expect(parsePublicationResult('none')).toEqual([])
  expect(parsePublicationResult('github.com/ggerganov/llama.cpp,zlib.net')).toEqual(['github.com/ggerganov/llama.cpp', 'zlib.net'])
  // Anything else is not a result: a message some other step wrote under the same title, say.
  for (const message of ['', 'curl.se, zlib.net', 'curl.se;id', 'a'.repeat(129)])
    expect(parsePublicationResult(message)).toBeNull()
})
