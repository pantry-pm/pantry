import type { VersionSourceOutcome } from '../src/installer'
import { describe, expect, it } from 'bun:test'
import {
  describeVersionSources,
  mergeVersionOutcomes,
  resolveInstallerConstraintFromCandidates,
  shouldConsultFallbackSource,
  unsatisfiableConstraintMessage,
} from '../src/installer'

// The bundled catalog as it shipped in the pantry build the failing workflow
// pinned: 1.4.0 is its ceiling, so `^1.4.1` has nothing to match in it.
const staleBundled: VersionSourceOutcome = {
  source: 'bundled catalog (this pantry build)',
  versions: ['1.4.0', '1.3.14', '1.3.13'],
}

const rateLimited: VersionSourceOutcome = {
  source: 'api.github.com/repos/oven-sh/bun/releases',
  versions: [],
  error: 'HTTP 403 fetching https://api.github.com/repos/oven-sh/bun/releases?per_page=100',
}

const mirrored: VersionSourceOutcome = {
  source: 'https://registry.pantry.dev/binaries/bun.com (darwin-arm64)',
  versions: ['1.4.2', '1.4.1', '1.4.0', '1.3.14'],
}

describe('live version source outcomes', () => {
  it('treats an errored source as a reason to consult the fallback', () => {
    // `[]` from a 403 and `[]` from "upstream published nothing" are the same
    // value; only the recorded error separates them.
    expect(shouldConsultFallbackSource(rateLimited)).toBe(true)
    expect(shouldConsultFallbackSource({ source: 'upstream', versions: [] })).toBe(true)
    expect(shouldConsultFallbackSource({ source: 'upstream', versions: ['1.4.2'] })).toBe(false)
  })

  it('resolves a pin above the stale ceiling from the fallback source', () => {
    const degraded = mergeVersionOutcomes([rateLimited, staleBundled])
    expect(resolveInstallerConstraintFromCandidates('^1.4.1', degraded)).toBeNull()

    // With the registry consulted in the rate-limited source's place, the pin
    // the workflow actually wrote resolves — and to the newest match, not the
    // floor it names.
    const recovered = mergeVersionOutcomes([rateLimited, mirrored, staleBundled])
    expect(resolveInstallerConstraintFromCandidates('^1.4.1', recovered)).toBe('1.4.2')
    expect(resolveInstallerConstraintFromCandidates('^1.4.0', recovered)).toBe('1.4.2')
  })

  it('merges sources newest-first without duplicating shared versions', () => {
    expect(mergeVersionOutcomes([mirrored, staleBundled])).toEqual([
      '1.4.2',
      '1.4.1',
      '1.4.0',
      '1.3.14',
      '1.3.13',
    ])
  })

  it('names every source consulted, and says which ones errored', () => {
    const described = describeVersionSources([rateLimited, mirrored, staleBundled])
    expect(described).toContain('api.github.com/repos/oven-sh/bun/releases: unavailable (HTTP 403')
    expect(described).toContain('(darwin-arm64): 4 versions, newest 1.4.2')
    expect(described).toContain('bundled catalog (this pantry build): 3 versions, newest 1.4.0')
  })

  it('reports an unsatisfiable pin as incomplete when a source was unreachable', () => {
    const message = unsatisfiableConstraintMessage('bun.com', '^1.4.1', [rateLimited, staleBundled])
    expect(message).toContain('No version of bun.com satisfies "^1.4.1".')
    // The fact that explained the failure, and that the old one-line message
    // ("checked 143 versions, newest 1.4.0") left out entirely.
    expect(message).toContain('1 of 2 version sources could not be consulted')
    expect(message).toContain('HTTP 403')

    // With every source reachable, the pin really is unsatisfiable and the
    // message must not hedge about it.
    const genuine = unsatisfiableConstraintMessage('bun.com', '^9.0.0', [mirrored, staleBundled])
    expect(genuine).not.toContain('could not be consulted')
  })
})
