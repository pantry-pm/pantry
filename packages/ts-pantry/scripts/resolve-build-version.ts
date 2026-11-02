import { appendFileSync } from 'node:fs'

/** Resolve generated metadata by its canonical domain, including nested providers. */
export async function resolveBuildVersion(domain: string, requested = ''): Promise<string> {
  if (!domain.split('/').every(segment => /^[a-z0-9][a-z0-9._-]*$/i.test(segment) && !segment.includes('..')))
    throw new Error('Provide a canonical package domain')
  const exactVersion = (version: string): string => {
    if (!/^[0-9][a-z0-9._+-]*$/i.test(version)) throw new Error('Provide an exact package version')
    return version
  }
  if (requested) return exactVersion(requested)

  // The generated catalog owns actual filenames and collision-resolved keys.
  // Compare declared domains rather than guessing either identity from a name.
  const { pantry } = await import('../src/packages')
  for (const value of Object.values(pantry)) {
    if (value.domain !== domain || typeof value.versions[0] !== 'string') continue
    return exactVersion(value.versions[0])
  }
  throw new Error(`No generated version for ${domain}; specify an exact version`)
}

if (import.meta.main) {
  const domain = process.env.REQUESTED_PACKAGE || ''
  const version = await resolveBuildVersion(domain, process.env.REQUESTED_VERSION)
  if (!process.env.GITHUB_OUTPUT) throw new Error('GitHub output file is required')
  appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`)
  console.log(`Building ${domain} version ${version}`)
}
