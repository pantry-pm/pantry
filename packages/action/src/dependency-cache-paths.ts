import path from 'node:path'

export interface CachedNativePrefix {
  domain: string
  version?: string
}

/** Files owned by the native dependency cache, rather than the workspace. */
export function dependencyCachePaths(pantryDir: string, prefixes: CachedNativePrefix[]): string[] {
  const result = new Set<string>()
  for (const { domain, version } of prefixes) {
    const segments = domain.split('/')
    if (!segments.length || segments.some(segment => !segment || /[^a-z0-9_.+-]/i.test(segment) || segment === '.' || segment === '..'))
      throw new Error(`Invalid native cache domain: ${domain}`)
    if (version !== undefined && (!/^[a-z0-9]/i.test(version) || /[^a-z0-9._+-]/i.test(version)))
      throw new Error(`Invalid native cache version: ${version}`)
    result.add(path.join(pantryDir, domain, `v${version ?? '*'}`))
  }
  return [...result].sort()
}
