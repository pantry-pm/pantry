import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

// The historical name for the shared vocabulary; see `./platforms`.
import { ALL_PLATFORMS as ALL_BUILD_PLATFORMS } from './platforms'

export { ALL_BUILD_PLATFORMS }

function sourceFiles(root: string): string[] {
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(path)
    }
  }
  walk(root)
  return files
}

export function packageCatalogFromSource(source: string): { domain: string, versions: string[] } | null {
  const domain = source.match(/\bdomain:\s*(['"])([^'"]+)\1\s+as const/)?.[2]
  const versionsBlock = source.match(/\bversions:\s*\[([\s\S]*?)\]\s+as const/)?.[1]
  if (!domain || versionsBlock === undefined) return null
  const versions = [...versionsBlock.matchAll(/['"]([^'"]+)['"]/g)].map(match => match[1])
  return { domain, versions }
}

export function loadPackageVersions(packagesRoot: string): Map<string, Set<string>> {
  const packages = new Map<string, Set<string>>()
  for (const file of sourceFiles(packagesRoot)) {
    if (file.endsWith(`${sep}index.ts`) || file.endsWith(`${sep}aliases.ts`)) continue
    const parsed = packageCatalogFromSource(readFileSync(file, 'utf8'))
    if (parsed) packages.set(parsed.domain, new Set(parsed.versions))
  }
  return packages
}

export function mapPlatformTokens(tokens: string[]): string[] {
  const platforms = new Set<string>()
  for (const raw of tokens) {
    const token = raw.trim().replace(/^['"]|['"]$/g, '')
    if (!token) continue
    const [os, arch] = token.split('/')
    const normalizedArch =
      arch === 'aarch64' || arch === 'arm64'
        ? 'arm64'
        : arch === 'x86-64' || arch === 'x86_64'
          ? 'x86-64'
          : arch
    if (os === 'darwin') {
      if (normalizedArch) platforms.add(`darwin-${normalizedArch}`)
      else {
        platforms.add('darwin-arm64')
        platforms.add('darwin-x86-64')
      }
    }
    else if (os === 'linux') {
      if (normalizedArch) platforms.add(`linux-${normalizedArch}`)
      else {
        platforms.add('linux-arm64')
        platforms.add('linux-x86-64')
      }
    }
  }
  return [...platforms].filter(platform => ALL_BUILD_PLATFORMS.includes(platform as typeof ALL_BUILD_PLATFORMS[number]))
}

export function loadSupportedPlatforms(recipesRoot: string): Map<string, string[]> {
  const packages = new Map<string, string[]>()
  for (const file of sourceFiles(recipesRoot)) {
    const source = readFileSync(file, 'utf8')
    const match = source.match(/platforms:\s*\[([^\]]*)\]/)
    if (!match) continue
    const platforms = mapPlatformTokens(match[1].split(','))
    if (platforms.length > 0 && platforms.length < ALL_BUILD_PLATFORMS.length) {
      const domain = relative(recipesRoot, file).replace(/\.ts$/, '').split(sep).join('/')
      packages.set(domain, platforms)
    }
  }
  return packages
}
