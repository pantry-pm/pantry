import { describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { loadDocumentationContractSources, validateDocumentationContracts } from './docs-contracts'

describe('documentation contracts', () => {
  const sources = loadDocumentationContractSources(resolve(import.meta.dir, '..'))

  it('covers the current package-manager and registry sources', () => {
    expect(validateDocumentationContracts(sources)).toEqual([])
  })

  it('detects removed source behavior', () => {
    const changed = { ...sources, mainSource: sources.mainSource.replace('BaseCommand.init(allocator, "install"', 'removed-install-command') }
    expect(validateDocumentationContracts(changed)).toContain('package command install: source marker is missing from mainSource')
  })

  it('detects missing documentation and legacy claims', () => {
    const changed = {
      ...sources,
      registryDoc: sources.registryDoc.replace('/publish/commit', '/removed-commit-route'),
      faqDoc: `${sources.faqDoc}\nPantry uses the pkgx registry through ts-pantry.`,
    }
    const errors = validateDocumentationContracts(changed)
    expect(errors).toContain('registry route commit publish: documentation marker is missing from registryDoc')
    expect(errors).toContain('legacy pkgx-registry claim remains in the FAQ')
  })
})
