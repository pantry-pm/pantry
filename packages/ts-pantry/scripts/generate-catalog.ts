import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pantry } from '../src/packages'
import { desktopApps, desktopFonts } from '../src/catalog/desktop'
import type { PackageCatalogEntry, PackageKind, PackageLogo } from '../src/catalog/types'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const logos = JSON.parse(readFileSync(join(root, 'catalog/logos.json'), 'utf8')) as Record<string, PackageLogo>
const recipePlatforms = new Map<string, string[]>()
const recipeMetadata = new Map<string, { name: string, description: string, homepageUrl: string | null, githubUrl: string | null, programs: string[] }>()
function scan(dir: string) {
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, item.name)
    if (item.isDirectory()) scan(file)
    else if (item.name.endsWith('.ts')) {
      const source = readFileSync(file, 'utf8')
      const domain = source.match(/\bdomain:\s*['"]([^'"]+)['"]/)?.[1]
      const platforms = source.match(/\bplatforms:\s*\[([^\]]*)\]/)?.[1]
      if (domain) recipeMetadata.set(domain, {
        name: source.match(/\bname:\s*['"]([^'"]+)['"]/)?.[1] ?? domain,
        description: (source.match(/\bdescription:\s*['"]([^'"]+)['"]/)?.[1] ?? '').replace(/[—–]/g, '-'),
        homepageUrl: webUrl(source.match(/\bhomepage:\s*['"]([^'"]+)['"]/)?.[1]),
        githubUrl: webUrl(source.match(/\bgithub:\s*['"]([^'"]+)['"]/)?.[1]),
        programs: [...(source.match(/\bprograms:\s*\[([^\]]*)\]/)?.[1] ?? '').matchAll(/['"]([^'"]+)['"]/g)].map(match => match[1]!),
      })
      if (domain && platforms) recipePlatforms.set(domain, [...platforms.matchAll(/['"]([^'"]+)['"]/g)].map(match => match[1]!))
    }
  }
}
scan(join(root, 'packages/ts-pantry/src/recipes'))
const apps = new Map(desktopApps.map(app => [app.domain, app]))
const fonts = new Map(desktopFonts.map(font => [font.domain, font]))
function webUrl(value: string | undefined): string | null {
  if (!value) return null
  try {
    const url = new URL(value.includes('://') ? value : `https://${value}`)
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null
  }
  catch { return null }
}
const indexAliases = new Map<string, Set<string>>()
for (const [alias, pkg] of Object.entries(pantry)) {
  const names = indexAliases.get(pkg.domain) ?? new Set<string>()
  if (alias !== pkg.domain) names.add(alias)
  indexAliases.set(pkg.domain, names)
}
const catalog = new Map<string, PackageCatalogEntry>()
for (const pkg of Object.values(pantry) as Array<{ domain: string, name: string, description: string, aliases?: readonly string[], programs: readonly string[], versions: readonly string[], homepageUrl?: string, githubUrl?: string }>) {
  if (catalog.has(pkg.domain)) continue
  const product = apps.get(pkg.domain) ?? fonts.get(pkg.domain)
  const kind: PackageKind = apps.has(pkg.domain) ? 'app' : fonts.has(pkg.domain) ? 'font' : pkg.programs.length ? 'cli' : 'library'
  catalog.set(pkg.domain, {
    domain: pkg.domain, name: product?.label ?? pkg.name,
    description: (product?.desc ?? pkg.description).replace(/[—–]/g, '-'), kind,
    aliases: [...new Set([...(pkg.aliases ?? []), ...(indexAliases.get(pkg.domain) ?? [])])], programs: [...pkg.programs],
    latestVersion: pkg.versions[0] ?? null, homepageUrl: webUrl(pkg.homepageUrl),
    githubUrl: webUrl(pkg.githubUrl), platforms: recipePlatforms.get(pkg.domain) ?? (kind === 'app' || kind === 'font' ? ['darwin'] : null),
    logo: logos[pkg.domain] ?? null,
  })
}
for (const [kind, products] of [['app', desktopApps], ['font', desktopFonts]] as const) {
  for (const product of products) {
    if (!catalog.has(product.domain)) catalog.set(product.domain, {domain: product.domain, name: product.label, description: product.desc, kind, aliases: [], programs: [], latestVersion: null, homepageUrl: kind === 'app' ? `https://${product.domain}` : null, githubUrl: null, platforms: ['darwin'], logo: logos[product.domain] ?? null})
  }
}
for (const [domain, recipe] of recipeMetadata) {
  if (!catalog.has(domain)) catalog.set(domain, { domain, ...recipe, kind: recipe.programs.length ? 'cli' : 'library', aliases: [], latestVersion: null, platforms: recipePlatforms.get(domain) ?? null, logo: logos[domain] ?? null })
}
const entries = [...catalog.values()].sort((a, b) => a.domain.localeCompare(b.domain))
writeFileSync(join(root, 'catalog/packages.json'), JSON.stringify({ schemaVersion: 1, revision: createHash('sha256').update(JSON.stringify(entries)).digest('hex'), packages: entries }, null, 2) + '\n')
console.log(`Generated ${entries.length} catalog entries; ${entries.filter(entry => entry.logo).length} original logos.`)
