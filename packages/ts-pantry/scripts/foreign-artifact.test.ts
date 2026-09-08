import { describe, expect, test } from 'bun:test'
import { distinctArchitectures } from './build-package'

describe('distinctArchitectures', () => {
  // The foreign-target check exists to catch an arch-mapping bug, and such a
  // bug produces native files of exactly ONE architecture — whichever we
  // fetched by mistake. A package shipping several at once is doing something
  // else deliberately. Counting them is what separates the two, so the check
  // can stop rejecting cassandra.apache.org's lib/sigar-bin bundle without
  // going blind to a genuinely wrong download.
  // Verbatim `file -bL` output from cassandra 5.0.9's own lib/sigar-bin.
  const sigarBundle = [
    { out: '64-bit XCOFF executable or object module' },
    { out: 'ELF 64-bit LSB shared object, x86-64, version 1 (SYSV), dynamically linked, not stripped' },
    { out: 'ELF 64-bit MSB shared object, 64-bit PowerPC or cisco 7500, Unspecified or Power ELF V1 ABI, version 1 (SYSV), dynamically linked, not stripped' },
    { out: 'ELF 32-bit MSB shared object, SPARC, version 1 (SYSV), dynamically linked, not stripped' },
  ]

  test('counts a deliberate multi-platform bundle as many', () => {
    expect(distinctArchitectures(sigarBundle)).toBeGreaterThanOrEqual(3)
  })

  test('a wrong download is one architecture, and stays a failure', () => {
    const wrongDownload = [
      { out: 'ELF 64-bit LSB executable, x86-64, version 1 (SYSV), statically linked' },
      { out: 'ELF 64-bit LSB shared object, x86-64, version 1 (SYSV)' },
    ]
    expect(distinctArchitectures(wrongDownload)).toBe(1)
  })

  test('the correct single-arch artifact is also one', () => {
    expect(distinctArchitectures([
      { out: 'Mach-O 64-bit executable arm64' },
    ])).toBe(1)
  })

  test('ignores text that names no architecture', () => {
    expect(distinctArchitectures([
      { out: 'Python script, ASCII text executable' },
      { out: 'ASCII text' },
    ])).toBe(0)
  })
})
