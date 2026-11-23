/**
 * The executables a package's catalog entry promises, and whether a prefix has them.
 *
 * A recipe has its own `programs` list, and a source build is checked against
 * it. The catalog entry (`src/packages/<domain>.ts`) is a different list: it is
 * what `generated.zig` is written from, so it is what every released client
 * requires of an artifact after extracting it. An artifact that satisfies the
 * recipe and not the catalog publishes cleanly and then fails every install
 * with `InvalidPackageSource`.
 *
 * A mirrored vendor build runs no recipe step, so nothing compared it with
 * either list. gnu.org/coreutils 9.10.0.1 was such a mirror: the vendor build
 * has no `chcon` or `runcon`, the catalog declares both, and for as long as it
 * was the newest coreutils no Linux install that depended on coreutils worked.
 */

import { readFileSync } from 'node:fs'
import { programsForPlatform } from '../src/programs'
import type { PlatformPrograms, ProgramVersions } from '../src/programs'
import { verifyDeclaredPrograms } from './declared-programs'
import { findPackageFile } from './version-fetcher'

interface CatalogEntry {
  programs: readonly string[]
  platformPrograms?: PlatformPrograms
  platformProgramOverrides?: PlatformPrograms
  programVersions?: ProgramVersions
}

/** Read the entry's program fields from its current bytes, the way the Zig generator does. */
async function loadCatalogEntry(path: string): Promise<CatalogEntry | undefined> {
  const source = readFileSync(path, 'utf-8')
  const name = source.match(/export const (\w+) = \{/)?.[1]
  if (!name) return undefined
  const javascript = new Bun.Transpiler({ loader: 'ts' }).transformSync(source)
  const module = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`)
  const entry = module[name]
  if (!entry || !Array.isArray(entry.programs)) return undefined
  return entry as CatalogEntry
}

/**
 * The programs a client on `platform` requires of `domain`@`version`.
 * Empty when the domain has no catalog entry, or its entry declares none.
 */
export async function catalogPrograms(domain: string, platform: string, version?: string, packagesDirectory?: string): Promise<string[]> {
  const path = findPackageFile(domain, packagesDirectory)
  if (!path) return []
  const entry = await loadCatalogEntry(path)
  return entry ? programsForPlatform(entry, platform, version) : []
}

/**
 * Why `prefix` cannot be published as `domain` for `platform`, or `undefined`
 * when it supplies every program the catalog declares.
 */
export async function missingCatalogProgram(prefix: string, domain: string, platform: string, version?: string, packagesDirectory?: string): Promise<string | undefined> {
  const programs = await catalogPrograms(domain, platform, version, packagesDirectory)
  try {
    verifyDeclaredPrograms(prefix, domain, programs)
    return undefined
  }
  catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}
