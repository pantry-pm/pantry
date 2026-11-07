#!/usr/bin/env bun
/** Daily desktop updates: recipe discovery → frozen plan → scan-gated publication → verified manifest. */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import process from 'node:process'
import { $ } from 'bun'
import type { Recipe, VersionSource } from './recipe-types'
import { findRecipeFile } from './recipe-loader'
import { fetchVersions, sortVersionsDesc } from './version-fetcher'
import { archiveFingerprint, desktopBundleVersion } from './desktop-bundle-source'
import desktopCatalog from '../../../catalog/desktop.json'

const ROOT = join(import.meta.dir, '..')
const RECIPES_DIR = join(ROOT, 'src/recipes')
const MANIFEST = join(ROOT, 'desktop-versions.json')
const REGISTRY = process.env.PANTRY_REGISTRY_URL || 'https://registry.pantry.dev'
const TIMEOUT = 15_000
export type Host = 'ubuntu' | 'macos'
export interface Target { platform: string, host: Host }
export interface Entry {
  domain: string, name: string, kind: 'app' | 'font', repo: string | null,
  latest: string | null, published: string | null, needsUpdate: boolean, host: Host,
  targets?: Target[], pendingTargets?: Target[], error?: string,
  sourceUrl?: string, sourceFingerprint?: string, force?: boolean,
}
export interface Plan { schema: 1, packages: Entry[] }
export interface RegistryMetadata {
  latestVersion?: string
  versions?: Record<string, { platforms?: Record<string, { tarball?: string, sha256?: string, size?: number, malwareScan?: { verdict?: string, artifactSha256?: string } }> }>
}

const MACOS_BUILD = /\bhdiutil\b|\bditto\b|\bsips\b|\bpkgutil\b|\binstaller\b|\bcodesign\b|\bspctl\b|\bxcrun\b|\.dmg\b|\.pkg\b/
export function needsMacos(recipe: Pick<Recipe, 'build' | 'versionSource'>): boolean {
  const steps = recipe?.build?.script ?? []
  const text = (Array.isArray(steps) ? steps : [steps]).map(step => typeof step === 'string' ? step : step.run).flat().join('\n')
  return recipe.versionSource?.type === 'desktop-bundle' || MACOS_BUILD.test(text)
}

/** New publications target maintained architectures only; old Intel artifacts remain served. */
export function publicationTargets(recipe: Recipe): Target[] {
  const supported: Record<string, string> = { 'darwin/aarch64': 'darwin-arm64', 'darwin/arm64': 'darwin-arm64', 'linux/aarch64': 'linux-arm64', 'linux/arm64': 'linux-arm64', 'linux/x86-64': 'linux-x86-64', 'linux/x86_64': 'linux-x86-64' }
  const targets = [...new Set((recipe.platforms ?? []).map(platform => supported[platform]).filter(Boolean))]
  if (!targets.length) throw new Error(`${recipe.domain}: no maintained desktop publication platform`)
  return targets.map(platform => ({ platform, host: platform.startsWith('darwin') && needsMacos(recipe) ? 'macos' : 'ubuntu' }))
}

/** A version number alone is not an installable, scanned artifact for this target. */
export function hasPublishedArtifact(metadata: RegistryMetadata | null, version: string, platform: string): boolean {
  const artifact = metadata?.versions?.[version]?.platforms?.[platform]
  return Boolean(artifact?.tarball && /^[a-f0-9]{64}$/i.test(artifact.sha256 ?? '') && (artifact.size ?? 0) > 0
    && artifact.malwareScan?.verdict === 'clean' && artifact.malwareScan.artifactSha256 === artifact.sha256)
}

export function isNewerVersion(a: string, b: string): boolean {
  return a !== b && sortVersionsDesc([b, a])[0] === a
}

function ghHeaders(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
  return { Accept: 'application/vnd.github+json', 'User-Agent': 'pantry-desktop-updater', ...(token ? { Authorization: `Bearer ${token}` } : {}) }
}
function tagVersion(tag: unknown, pattern?: RegExp): string | null {
  if (typeof tag !== 'string') return null
  if (!pattern) return tag.replace(/^v/, '')
  const match = tag.match(new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, '')))
  return match?.[1] ? match.slice(1).filter(Boolean).join('.') : null
}
const MOBILE_ASSET = /\.(?:apk|aab|ipa)$/i
const DESKTOP_ASSET = /\.(?:dmg|zip|pkg|exe|msi|msix|appx|deb|rpm|AppImage|tar\.(?:gz|xz|bz2)|tgz)$/i
function desktopRelease(release: any): boolean {
  const assets: any[] = Array.isArray(release.assets) ? release.assets : []
  return assets.length === 0 || assets.some(asset => typeof asset?.name === 'string' && DESKTOP_ASSET.test(asset.name) && !MOBILE_ASSET.test(asset.name))
}
/** Product tags and stable policy are authoritative, even when /latest points to another product. */
export async function latestGithub(repo: string, pattern?: RegExp, stable = true): Promise<string | null> {
  const get = async (path: string) => {
    const response = await fetch(`https://api.github.com/repos/${repo}/${path}`, { headers: ghHeaders(), signal: AbortSignal.timeout(TIMEOUT) })
    if (!response.ok) throw new Error(`${repo}: HTTP ${response.status}`)
    return response.json() as Promise<any>
  }
  const latest = await get('releases/latest')
  const version = tagVersion(latest.tag_name, pattern)
  if (version && !latest.draft && (!stable || !latest.prerelease) && desktopRelease(latest)) return version
  const releases = await get('releases?per_page=100')
  if (!Array.isArray(releases)) throw new Error(`${repo}: invalid GitHub releases response`)
  const versions = releases.filter(release => !release.draft && (!stable || !release.prerelease) && desktopRelease(release))
    .map(release => tagVersion(release.tag_name, pattern)).filter((value): value is string => Boolean(value))
  return sortVersionsDesc(versions)[0] ?? null
}

export async function latestRecipeVersion(source: VersionSource | undefined): Promise<string> {
  if (!source) throw new Error('No live version source')
  const operation = async () => source.type === 'github-releases'
    ? [await latestGithub(source.repo, source.tagPattern, source.stable !== false)]
    : await fetchVersions(source)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const versions = await Promise.race([operation(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Upstream version lookup timed out')), 30_000) })])
    const valid = versions.filter((version): version is string => typeof version === 'string' && /^\d[\w.+-]*$/.test(version))
    if (!valid.length) throw new Error('Upstream returned no usable desktop versions')
    return sortVersionsDesc(valid)[0]
  }
  finally { clearTimeout(timer) }
}

/** All local apps/fonts and catalog entries, including slash-domains outside apps/. */
export async function discoverRecipes(): Promise<Array<{ recipe: Recipe, kind: 'app' | 'font' }>> {
  const files = new Map<string, 'app' | 'font'>()
  const walk = (dir: string, kind: 'app' | 'font') => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path, kind)
      else if (entry.name.endsWith('.ts')) files.set(path, kind)
    }
  }
  walk(join(RECIPES_DIR, 'apps'), 'app')
  walk(join(RECIPES_DIR, 'fonts'), 'font')
  for (const app of desktopCatalog.apps) {
    const file = findRecipeFile(app.domain)
    if (!file) throw new Error(`Catalog app ${app.domain} has no recipe`)
    files.set(file, 'app')
  }
  const seen = new Set<string>()
  const recipes = []
  for (const [file, kind] of files) {
    const recipe = (await import(file)).recipe as Recipe
    if (!recipe?.domain) throw new Error(`Invalid desktop recipe: ${relative(ROOT, file)}`)
    if (seen.has(recipe.domain)) throw new Error(`Duplicate desktop domain: ${recipe.domain}`)
    seen.add(recipe.domain)
    recipes.push({ recipe, kind })
  }
  for (const app of desktopCatalog.apps) {
    if (!seen.has(app.domain)) throw new Error(`Catalog domain ${app.domain} resolved to a different recipe`)
  }
  return recipes
}

async function metadata(domain: string): Promise<RegistryMetadata | null> {
  const response = await fetch(`${REGISTRY}/binaries/${domain}/metadata.json?verify=${Date.now()}`, { cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT) })
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`${domain}: registry HTTP ${response.status}`)
  const data = await response.json() as RegistryMetadata
  if (!data || typeof data !== 'object' || !data.versions) throw new Error(`${domain}: invalid registry metadata`)
  return data
}

export async function planEntry(recipe: Recipe, kind: 'app' | 'font', previous: Entry | undefined, published: RegistryMetadata | null, force = false): Promise<Entry> {
  const targets = publicationTargets(recipe)
  const source = recipe.versionSource
  const entry: Entry = { domain: recipe.domain, name: recipe.name, kind, repo: source?.type === 'github-releases' ? source.repo : null,
    host: needsMacos(recipe) ? 'macos' : 'ubuntu', targets, latest: null, published: published?.latestVersion ?? null, needsUpdate: false, pendingTargets: [], force }
  try {
    if (source?.type === 'desktop-bundle') {
      entry.sourceUrl = source.url
      entry.sourceFingerprint = await archiveFingerprint(source)
      if (previous?.sourceFingerprint === entry.sourceFingerprint && previous.latest) entry.latest = previous.latest
    }
    else entry.latest = await latestRecipeVersion(source)
    // Do not downgrade when a vendor feed lags the registry. Still repair a missing target.
    if (entry.latest && entry.published && isNewerVersion(entry.published, entry.latest)) entry.latest = entry.published
    entry.pendingTargets = targets.filter(target => force || !entry.latest || !hasPublishedArtifact(published, entry.latest, target.platform))
    entry.needsUpdate = entry.pendingTargets.length > 0
  }
  catch (error) { entry.error = String(error) }
  return entry
}

async function verifyEntry(entry: Entry): Promise<void> {
  if (!entry.latest || entry.error) throw new Error(`${entry.domain}: unresolved upstream: ${entry.error ?? 'missing bundle version'}`)
  for (let attempt = 0; attempt < 6; attempt++) {
    const data = await metadata(entry.domain)
    if (entry.targets?.every(target => hasPublishedArtifact(data, entry.latest!, target.platform))) return
    if (attempt < 5) await Bun.sleep((attempt + 1) * 1000)
  }
  throw new Error(`${entry.domain}@${entry.latest}: missing clean, checksum-bound publication for a required target`)
}

/** Continue independent packages after a failure; report all failed publications at the end. */
export async function publishPlan(entries: Entry[], host: Host | 'all', ports: {
  resolveBundle: (entry: Entry) => Promise<string>,
  publish: (entry: Entry, target: Target) => Promise<void>,
  verify: (entry: Entry, target: Target) => Promise<void>,
}): Promise<{ packages: Entry[], failures: string[] }> {
  const results: Entry[] = []
  const failures = entries.filter(entry => entry.error).map(entry => `${entry.domain}: ${entry.error}`)
  for (const input of entries) {
    const targets = (input.pendingTargets ?? []).filter(target => host === 'all' || target.host === host)
    if (!targets.length || input.error) continue
    const entry = { ...input }
    try {
      if (!entry.latest) entry.latest = await ports.resolveBundle(entry)
      for (const target of targets) {
        await ports.publish(entry, target)
        await ports.verify(entry, target)
      }
      results.push(entry)
    }
    catch (error) { failures.push(`${entry.domain}: ${error}`) }
  }
  return { packages: results, failures }
}

function readPlan(path: string): Plan {
  const plan = JSON.parse(readFileSync(path, 'utf8')) as Plan
  if (plan.schema !== 1 || !Array.isArray(plan.packages)) throw new Error('Unsupported desktop update plan')
  return plan
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const has = (flag: string) => args.includes(flag)
  const value = (flag: string) => args.find(arg => arg.startsWith(`${flag}=`))?.slice(flag.length + 1)
  const host = value('--platform') ?? 'all'
  if (!['macos', 'ubuntu', 'all'].includes(host)) throw new Error(`Invalid build host: ${host}`)
  if (has('--publish') && has('--commit')) throw new Error('Publish and record must be separate invocations')
  const previous: Entry[] = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')).packages : []
  const from = value('--from-plan')
  let plan: Plan
  if (from) plan = readPlan(resolve(from))
  else {
    const recipes = await discoverRecipes()
    const forced = new Set((value('--force') ?? '').split(',').filter(Boolean))
    for (const domain of forced) { if (!recipes.some(({ recipe }) => recipe.domain === domain)) throw new Error(`Unknown desktop package: ${domain}`) }
    const entries: Entry[] = []
    // Bound concurrency: one slow vendor cannot serialize the entire catalog.
    for (let offset = 0; offset < recipes.length; offset += 6) {
      entries.push(...await Promise.all(recipes.slice(offset, offset + 6).map(async ({ recipe, kind }) =>
        planEntry(recipe, kind, previous.find(entry => entry.domain === recipe.domain), await metadata(recipe.domain), forced.has(recipe.domain)))))
    }
    plan = { schema: 1, packages: entries.sort((a, b) => a.domain.localeCompare(b.domain)) }
  }
  const outputPlan = value('--plan')
  if (outputPlan) writeFileSync(resolve(outputPlan), `${JSON.stringify(plan, null, 2)}\n`)
  for (const entry of plan.packages) console.warn(`  ${entry.error ? '!' : entry.needsUpdate ? '⬆' : '✓'} ${entry.domain}: upstream=${entry.latest ?? 'native bundle discovery'} published=${entry.published ?? '—'}${entry.error ? ` (${entry.error})` : ''}`)
  console.warn(`${plan.packages.length} desktop packages, ${plan.packages.filter(entry => entry.needsUpdate).length} pending, ${plan.packages.filter(entry => entry.error).length} lookup errors`)
  if (has('--print-selected')) {
    console.log(plan.packages.filter(entry => entry.pendingTargets?.some(target => host === 'all' || target.host === host)).map(entry => entry.domain).join(','))
    return
  }
  if (has('--publish')) {
    const result = await publishPlan(plan.packages, host as Host | 'all', {
      resolveBundle: async entry => {
        const file = findRecipeFile(entry.domain)
        const recipe: Recipe = (await import(file!)).recipe
        if (recipe.versionSource?.type !== 'desktop-bundle' || !entry.sourceFingerprint) throw new Error('Missing bundle source or fingerprint')
        return desktopBundleVersion(recipe.versionSource, entry.sourceFingerprint)
      },
      publish: async (entry, target) => {
        // A changed rolling installer may retain its version; immutable releases do not get overwritten.
        if (hasPublishedArtifact(await metadata(entry.domain), entry.latest!, target.platform) && !entry.force) return
        await $`./scripts/build-and-upload.sh ${entry.domain} ${entry.latest} pantry-registry us-east-1 ${target.platform}`.cwd(ROOT)
      },
      verify: async (entry, target) => verifyEntry({ ...entry, targets: [target] }),
    })
    const output = value('--results')
    if (output) writeFileSync(resolve(output), `${JSON.stringify({ schema: 1, packages: result.packages }, null, 2)}\n`)
    if (result.failures.length) throw new Error(`Desktop updates failed:\n${result.failures.join('\n')}`)
    return
  }
  if (has('--require-current') || has('--commit')) {
    const resultDirectory = value('--results-dir')
    if (resultDirectory) {
      for (const filename of readdirSync(resolve(resultDirectory))) {
        if (!filename.endsWith('.json')) continue
        for (const receipt of readPlan(join(resolve(resultDirectory), filename)).packages) {
          const entry = plan.packages.find(candidate => candidate.domain === receipt.domain)
          if (!entry || entry.sourceFingerprint !== receipt.sourceFingerprint) throw new Error('Publication receipt does not match update plan')
          if (entry.latest && entry.latest !== receipt.latest) throw new Error('Publication changed the planned version')
          entry.latest = receipt.latest
        }
      }
    }
    // Verify every package before writing anything. Unresolved vendors cannot silently become green.
    const failures: string[] = []
    for (const entry of plan.packages) {
      try { await verifyEntry(entry) }
      catch (error) { failures.push(String(error)) }
    }
    if (failures.length) throw new Error(`Refusing to record incomplete desktop updates:\n${failures.join('\n')}`)
    const packages = plan.packages.map(entry => ({ ...entry, published: entry.latest, needsUpdate: false, pendingTargets: [] }))
    writeFileSync(MANIFEST, `${JSON.stringify({ packages }, null, 2)}\n`)
    if (has('--commit') && (await $`git status --porcelain ${MANIFEST}`.cwd(ROOT).text()).trim()) {
      const changes = packages.map(entry => ({ ...entry, previousPublished: previous.find(old => old.domain === entry.domain)?.published ?? null })).filter(entry => entry.published !== entry.previousPublished)
      await $`git add ${MANIFEST}`.cwd(ROOT)
      await $`git commit -m ${commitSubject(changes)}`.cwd(ROOT)
    }
  }
}

export function commitSubject(published: Array<Entry & { previousPublished: string | null }>): string {
  if (published.length === 0)
    return 'chore(desktop): refresh version manifest'

  // Single update: name it exactly.
  if (published.length === 1) {
    const e = published[0]
    const name = e.name.trim() || e.domain
    return e.previousPublished
      ? `chore(desktop): publish ${e.kind} ${name} ${e.previousPublished} → ${e.published}`
      : `chore(desktop): publish ${e.kind} ${name} ${e.published}`
  }

  // Several: count per kind ("2 apps & 1 font"), append names if they fit.
  const n = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`
  const apps = published.filter(e => e.kind === 'app').length
  const fonts = published.filter(e => e.kind === 'font').length
  const what = [apps && n(apps, 'app'), fonts && n(fonts, 'font')].filter(Boolean).join(' & ')

  let subject = `chore(desktop): publish ${what}`
  const names = published.map(e => e.name.trim() || e.domain).join(', ')
  if (`${subject} (${names})`.length <= 72)
    subject += ` (${names})`
  return subject
}

if (import.meta.main) {
  main().catch(error => {
    console.error(error)
    process.exitCode = 1
  })
}
