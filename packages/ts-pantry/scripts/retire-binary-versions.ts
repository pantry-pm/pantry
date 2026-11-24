#!/usr/bin/env bun
/**
 * Withdraw published binary versions from resolution (operator token).
 *
 *   PANTRY_TOKEN=... bun scripts/retire-binary-versions.ts --reason "..." domain@version...
 *
 * The registry moves each version's artifacts under `.pantry-retired/` and
 * records why in the package metadata (`retiredVersions`); nothing is deleted,
 * and publishing the same version again (a vendor's real release) replaces
 * the record. For build identities that should never have existed, such as a
 * revision spelled as a vendor patch release (gnu.org/sed 4.10.1 for 4.10).
 */
import { parseArgs } from 'node:util'

export function parseSelector(selector: string): { domain: string, version: string } {
  const at = selector.lastIndexOf('@')
  if (at <= 0 || at === selector.length - 1) throw new Error(`expected domain@version, got ${selector}`)
  return { domain: selector.slice(0, at), version: selector.slice(at + 1) }
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { reason: { type: 'string' } } })
  if (!values.reason) throw new Error('--reason is required')
  const token = process.env.PANTRY_TOKEN
  if (!token) throw new Error('PANTRY_TOKEN is required')
  const registry = (process.env.PANTRY_REGISTRY_URL || 'https://registry.pantry.dev').replace(/\/+$/, '')
  let failed = 0
  for (const selector of positionals) {
    const { domain, version } = parseSelector(selector)
    const response = await fetch(`${registry}/api/v1/binaries/retire`, {
      method: 'POST',
      headers: { 'authorization': `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ domain, version, reason: values.reason }),
    })
    const body: { platforms?: string[], latestVersion?: string, code?: string, error?: string } = await response.json().catch(() => ({}))
    if (response.ok) {
      console.log(`retired ${domain}@${version} (${body.platforms?.join(', ')}); latest is now ${body.latestVersion}`)
    }
    else {
      failed++
      console.error(`could not retire ${domain}@${version}: HTTP ${response.status} ${body.code ?? ''} ${body.error ?? ''}`)
    }
  }
  if (failed) process.exit(1)
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`retire-binary-versions: ${(error as Error).message}`)
    process.exit(1)
  })
}
