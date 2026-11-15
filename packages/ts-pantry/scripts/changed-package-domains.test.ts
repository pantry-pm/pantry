import { describe, expect, it } from 'bun:test'
import { packageDomain, packageVersions, versionsChanged, parseBuildSummaryFailures, parsePublicationResult, PUBLICATION_RESULT_TITLE, publicationResultAnnotation } from './changed-package-domains'

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

it('reads the failed packages from the summary a publisher job without an annotation ends in', () => {
  const stamp = '2026-11-14T21:48:10.9913713Z '
  const log = (lines: string[]) => lines.map(line => stamp + line).join('\n')
  const summary = ['Build Summary', '═══', '', 'Skipped — already in S3 (2):', '   - fmt.dev@12.2.1', '   - mise.jdx.dev@2026.11.0', '', 'Failed (3):',
    '   - mise.jdx.dev@2026.11.4: build-package.ts exited with code 1: mise@2026.11.4 requires rustc 1.95',
    '   - mise.jdx.dev@2026.11.3: build-package.ts exited with code 1: mise@2026.11.3 requires rustc 1.95',
    '   - github.com/ggerganov/llama.cpp@8990.0.0: Cannot normalize ELF loader paths',
    '  0     0    0     0    0     0      0      0 --:--:-- --:--:-- --:--:--     0 | 100 16.0M  100 16.0M',
    '', 'Total: 0 uploaded, 2 skipped, 0 unavailable, 3 failed', '', 'Timing']
  expect(parseBuildSummaryFailures(log(summary))).toEqual(['github.com/ggerganov/llama.cpp', 'mise.jdx.dev'])
  // Without timestamps too: the format is the script's, not the log service's.
  expect(parseBuildSummaryFailures(summary.join('\n'))).toEqual(['github.com/ggerganov/llama.cpp', 'mise.jdx.dev'])
  // A build that prints a summary of its own does not get to speak for the job: the last one counts.
  const forged = ['Build Summary', 'Failed (1):', '   - innocent.example@1.0.0: no', 'Total: 0 uploaded, 0 skipped, 0 unavailable, 1 failed']
  expect(parseBuildSummaryFailures(log([...forged, ...summary]))).toEqual(['github.com/ggerganov/llama.cpp', 'mise.jdx.dev'])
  // No summary, nothing failed, or a list that does not add up to its total: nothing is read from it.
  expect(parseBuildSummaryFailures('The runner has received a shutdown signal.')).toBeNull()
  expect(parseBuildSummaryFailures(log(['Build Summary', '', 'Total: 4 uploaded, 0 skipped, 0 unavailable, 0 failed']))).toBeNull()
  expect(parseBuildSummaryFailures(log(summary.filter(line => !line.includes('2026.11.3'))))).toBeNull()
  expect(parseBuildSummaryFailures(log(['Build Summary', 'Failed (1):', '   - bad;domain@1.0.0: no', 'Total: 0 uploaded, 0 skipped, 0 unavailable, 1 failed']))).toBeNull()
})
