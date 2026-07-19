#!/usr/bin/env bun
/**
 * check-desktop-updates.ts — keep the desktop app & font recipes fresh.
 *
 * For every desktop-app and font recipe, resolve the latest upstream version
 * (GitHub releases, per the recipe's versionSource) and compare it to the
 * version currently published in the pantry registry. It then:
 *   - writes a `desktop-versions.json` manifest (the committed record),
 *   - with `--commit`, commits that manifest when it changed,
 *   - with `--require-current`, refuses to commit while any package is stale,
 *   - with `--publish`, builds + uploads any out-of-date package via
 *     build-and-upload.sh (needs S3/registry creds in the env — Hetzner Object
 *     Storage: STORAGE_PROVIDER=hetzner + S3_* + S3_ACCESS_KEY_ID/SECRET).
 *
 *   bun scripts/check-desktop-updates.ts                 # report only
 *   bun scripts/check-desktop-updates.ts --commit        # + commit manifest
 *   bun scripts/check-desktop-updates.ts --publish        # publish only
 *   bun scripts/check-desktop-updates.ts --require-current --commit
 *
 * Build-host selection: each recipe is classified by its build script as
 * needing macOS (mounts a .dmg / uses hdiutil/ditto/sips/installer/pkgutil)
 * or being "ubuntu-safe" (curl + unzip a .zip — most fonts and zip-based
 * apps). The CI workflow splits publishing across a fast ubuntu-latest job and
 * a macos-latest job so the whole pipeline no longer waits on the scarce macOS
 * runner queue. Select a host's slice with `--platform=ubuntu` / `--platform=macos`
 * (default: all). Affects which recipes get *published*; the manifest always
 * records every recipe.
 *
 *   bun scripts/check-desktop-updates.ts --platform=ubuntu --publish
 *   bun scripts/check-desktop-updates.ts --platform=macos  --publish
 *
 * Scope: every `*.font.ts` recipe (fonts) plus darwin-only download recipes
 * with a github-releases source (desktop apps). CLI packages are untouched —
 * they have their own version pipeline (build-versions.yml).
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { $ } from 'bun'

const ROOT = join(import.meta.dir, '..')
const RECIPES_DIR = join(ROOT, 'src', 'recipes')
const MANIFEST = join(ROOT, 'desktop-versions.json')
const REGISTRY = process.env.PANTRY_REGISTRY_URL || 'https://registry.pantry.dev'
const REGISTRY_TIMEOUT_MS = 10_000

const args = process.argv.slice(2)
const flags = new Set(args)
const doCommit = flags.has('--commit')
const doPublish = flags.has('--publish')
const requireCurrent = flags.has('--require-current')

/** Domains to (re)publish even when already at the latest published version —
 * `--force=roboto,pearcleaner.app`. Lets an operator re-run a publish after a
 * pipeline fix (e.g. re-keying a package's platforms) without bumping a version.
 * Empty/absent = no forcing. */
const forceDomains = new Set(
  (args.find(a => a.startsWith('--force='))?.slice('--force='.length) ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean),
)

/** Build host this run publishes for: 'ubuntu' (zip-only), 'macos' (.dmg /
 * macOS-tool recipes) or 'all' (default). Drives which out-of-date packages
 * actually get built + uploaded — the manifest still records every recipe. */
type Platform = 'ubuntu' | 'macos' | 'all'
const platform: Platform = (() => {
  const arg = args.find(a => a.startsWith('--platform=') || a.startsWith('--only='))
  const v = arg?.split('=')[1]
  if (v === 'ubuntu' || v === 'ubuntu-safe' || v === 'linux')
    return 'ubuntu'
  if (v === 'macos' || v === 'mac' || v === 'darwin')
    return 'macos'
  return 'all'
})()

/** Tokens in a build script that require a native macOS runner. Disk images
 * are intentionally mounted with Apple's hdiutil: third-party Linux extractors
 * do not support every DMG filesystem/compression combination and had allowed
 * the updater to report success while publishing no artifact. */
const MACOS_BUILD = /\bhdiutil\b|\bditto\b|\bsips\b|\bpkgutil\b|\binstaller\b|\.dmg\b/

/** Flatten a recipe's build script (strings + { run } step objects) to one
 * blob so we can scan it for macOS-only tooling. */
function buildScriptText(recipe: any): string {
  const steps: any[] = recipe?.build?.script ?? []
  const parts: string[] = []
  for (const step of steps) {
    if (typeof step === 'string')
      parts.push(step)
    else if (step && typeof step === 'object' && step.run)
      parts.push(Array.isArray(step.run) ? step.run.join('\n') : String(step.run))
  }
  return parts.join('\n')
}

/** True when a recipe must build on macOS (mounts a .dmg or uses a macOS-only
 * tool). Zip-only recipes (most fonts, apps like maccy/pearcleaner) are false
 * and publish fine on the fast ubuntu-latest runner. */
export function needsMacos(recipe: any): boolean {
  return MACOS_BUILD.test(buildScriptText(recipe))
}

/** True when version `a` is strictly newer than `b` by dotted-numeric order.
 * Mirrors the guard in scripts/upload-to-s3.ts so the updater never *attempts*
 * a downgrade: some upstream feeds lag the registry (e.g. the logi-options+
 * Homebrew cask reports an older version than we've already published from its
 * rolling installer), and without this we'd rebuild + re-tag an OLDER version
 * every run — overwriting latestVersion in DynamoDB. Non-numeric segments parse
 * as 0, so font-style versions ("2.015", "26.05") order the same way they do at
 * publish time. A release (no `-suffix`) outranks a prerelease at equal numerics. */
function isNewerVersion(a: string, b: string): boolean {
  const parse = (v: string) => {
    const dashIdx = v.indexOf('-')
    const numeric = (dashIdx === -1 ? v : v.slice(0, dashIdx)).split('.').map((s) => {
      const n = Number.parseInt(s, 10)
      return Number.isNaN(n) ? 0 : n
    })
    const prerelease = dashIdx === -1 ? null : v.slice(dashIdx + 1)
    return { numeric, prerelease }
  }
  const pa = parse(a)
  const pb = parse(b)
  const len = Math.max(pa.numeric.length, pb.numeric.length)
  for (let i = 0; i < len; i++) {
    const av = pa.numeric[i] ?? 0
    const bv = pb.numeric[i] ?? 0
    if (av !== bv)
      return av > bv
  }
  // Equal numerics: a release outranks a prerelease; two prereleases are not "newer".
  if (pa.prerelease === pb.prerelease)
    return false
  return pa.prerelease === null
}

interface Entry {
  domain: string
  name: string
  kind: 'app' | 'font'
  repo: string | null
  latest: string | null
  published: string | null
  needsUpdate: boolean
  /** 'macos' if the build script needs a macOS runner, else 'ubuntu'. */
  host: 'macos' | 'ubuntu'
}

function ghHeaders(): Record<string, string> {
  const h: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'pantry-desktop-version-check',
  }
  if (process.env.GITHUB_TOKEN)
    h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  return h
}

async function latestGithub(repo: string, tagPattern?: RegExp): Promise<string | null> {
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers: ghHeaders() })
    if (!res.ok)
      return null
    const tag = (await res.json() as any).tag_name as string
    if (!tag)
      return null
    if (tagPattern) {
      const m = tag.match(tagPattern)
      return m && m[1] ? m[1] : tag.replace(/^v/, '')
    }
    return tag.replace(/^v/, '')
  }
  catch {
    return null
  }
}

async function publishedVersion(domain: string, fresh = false): Promise<string | null> {
  try {
    const suffix = fresh ? `?verify=${Date.now()}` : ''
    const res = await fetch(`${REGISTRY}/binaries/${encodeURI(domain)}/metadata.json${suffix}`, {
      cache: fresh ? 'no-store' : 'default',
      signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
    })
    if (!res.ok)
      return null
    return (await res.json() as any)?.latestVersion || null
  }
  catch {
    return null
  }
}

/** Confirm that the registry exposes the version before allowing the workflow
 * to record it. The cache-busting query avoids briefly stale CDN responses. */
async function verifyPublishedVersion(domain: string, version: string): Promise<void> {
  const attempts = 6
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const published = await publishedVersion(domain, true)
    if (published === version) {
      console.warn(`  ✓ registry verified ${domain} @ ${version}`)
      return
    }
    if (attempt < attempts)
      await Bun.sleep(attempt * 1000)
  }
  throw new Error(`registry did not expose ${domain} @ ${version} after upload`)
}

/** List font recipes (every `.ts` under recipes/fonts/). */
function listFontRecipes(dir: string): string[] {
  const fontsDir = join(dir, 'fonts')
  if (!existsSync(fontsDir))
    return []
  const out: string[] = []
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const full = join(d, name)
      if (statSync(full).isDirectory())
        walk(full)
      else if (name.endsWith('.ts'))
        out.push(full)
    }
  }
  walk(fontsDir)
  return out
}

/** List app recipes (every `.ts` under recipes/apps/) so a newly-added desktop
 * app publishes from its local recipe — no wait on the server-side catalogue. */
function listAppRecipes(dir: string): string[] {
  const appsDir = join(dir, 'apps')
  if (!existsSync(appsDir))
    return []
  const out: string[] = []
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const full = join(d, name)
      if (statSync(full).isDirectory())
        walk(full)
      else if (name.endsWith('.ts'))
        out.push(full)
    }
  }
  walk(appsDir)
  return out
}

/** Locate `<domain>.ts` anywhere under recipes/ (recipes are organised into
 * fonts/ and apps/ subfolders). */
function findRecipeFile(dir: string, filename: string): string | null {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      const hit = findRecipeFile(full, filename)
      if (hit)
        return hit
    }
    else if (name === filename) {
      return full
    }
  }
  return null
}

/** The desktop-app domains the registry catalogues (so we only import ~40
 * recipes, not the thousands of CLI ones). Empty on network failure. */
async function appDomains(): Promise<string[]> {
  try {
    const res = await fetch(`${REGISTRY}/desktop-apps`, {
      signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
    })
    if (!res.ok)
      return []
    const data = await res.json() as any
    return (data.apps ?? []).map((a: any) => a.domain).filter(Boolean)
  }
  catch {
    return []
  }
}

async function main(): Promise<void> {
  if (doPublish && doCommit) {
    throw new Error('publish and commit must be separate invocations so the commit re-reads verified registry state')
  }

  const previouslyPublished = new Map<string, string | null>()
  if (existsSync(MANIFEST)) {
    try {
      const previous = JSON.parse(readFileSync(MANIFEST, 'utf8')) as { packages?: Array<{ domain?: string, published?: string | null }> }
      for (const pkg of previous.packages ?? []) {
        if (pkg.domain)
          previouslyPublished.set(pkg.domain, pkg.published ?? null)
      }
    }
    catch {
      // A malformed manifest will be replaced below; git still preserves the
      // before/after diff, but there is no safe prior version to put in the body.
    }
  }

  // Build the candidate (file, kind) set: every font recipe + the app recipes
  // that back the registry's desktop-app catalogue.
  const candidates: Array<{ file: string, kind: 'app' | 'font' }> = []
  const seen = new Set<string>()
  const add = (file: string | null, kind: 'app' | 'font'): void => {
    if (file && !seen.has(file)) {
      seen.add(file)
      candidates.push({ file, kind })
    }
  }
  for (const file of listFontRecipes(RECIPES_DIR))
    add(file, 'font')
  // Every local app recipe — lets a freshly-added app publish from its file
  // without first appearing in the live server-side desktop-app catalogue.
  for (const file of listAppRecipes(RECIPES_DIR))
    add(file, 'app')
  // Plus any app domains the registry catalogues (covers slash-domains and any
  // recipe that lives outside recipes/apps/).
  for (const domain of await appDomains()) {
    if (domain.includes('/'))
      continue // slash-domains stay in their own nested path; skip here
    add(findRecipeFile(RECIPES_DIR, `${domain}.ts`), 'app')
  }

  const entries: Entry[] = []
  for (const { file, kind } of candidates) {
    let recipe: any
    try {
      recipe = (await import(file)).recipe
    }
    catch {
      continue
    }
    if (!recipe || typeof recipe.domain !== 'string')
      continue

    const repo: string | null = recipe.versionSource?.type === 'github-releases'
      ? recipe.versionSource.repo
      : null
    const tagPattern: RegExp | undefined = recipe.versionSource?.tagPattern

    // Resolve the latest upstream version. `github-releases` queries the GitHub
    // API; `custom` calls the recipe's own `fetch()` (newest-first) — this lets
    // apps with no GitHub feed but a machine-readable version source (e.g.
    // Linear's Content-Disposition header) auto-update too. Other source types
    // (`github-tags`, `url-pattern`) and pinned recipes resolve to null and are
    // simply tracked at their published version (no auto-bump).
    let latest: string | null = repo ? await latestGithub(repo, tagPattern) : null
    if (!latest && recipe.versionSource?.type === 'custom' && typeof recipe.versionSource.fetch === 'function') {
      try {
        const versions = await recipe.versionSource.fetch()
        latest = Array.isArray(versions) && versions.length > 0 ? versions[0] : null
      }
      catch {
        latest = null
      }
    }
    // Pinned recipes (no machine-readable upstream feed) declare their version
    // via `knownVersions` — resolve to that so an unpublished pinned package
    // still gets built/published. Already-published ones stay no-op (latest ===
    // published), so this never causes spurious rebuilds.
    if (!latest && Array.isArray(recipe.versionSource?.knownVersions) && recipe.versionSource.knownVersions.length > 0) {
      latest = String(recipe.versionSource.knownVersions[0])
    }
    // The final record pass must bypass any stale CDN entry left from the
    // preceding uploads; ordinary discovery can use the cache-friendly URL.
    const published = await publishedVersion(recipe.domain, requireCurrent)
    entries.push({
      domain: recipe.domain,
      name: recipe.name ?? recipe.domain,
      kind,
      repo,
      latest,
      published,
      // Update only when we have a resolved upstream version that is genuinely
      // NEWER than what's published (or nothing is published yet) — never on a
      // mere string difference, which would let an upstream feed that lags the
      // registry trigger an endless downgrade. `--force` still re-publishes the
      // resolved latest regardless, for re-runs after a pipeline fix.
      needsUpdate: !!latest && (forceDomains.has(recipe.domain) || !published || isNewerVersion(latest, published)),
      host: needsMacos(recipe) ? 'macos' : 'ubuntu',
    })
  }

  entries.sort((a, b) => a.domain.localeCompare(b.domain))
  const outdated = entries.filter(e => e.needsUpdate)

  // Report.
  for (const e of entries) {
    const mark = e.needsUpdate ? '⬆' : (e.published ? '✓' : '·')
    console.warn(`  ${mark} [${e.host === 'macos' ? 'macos ' : 'ubuntu'}] ${e.domain.padEnd(34)} latest=${e.latest ?? '?'} published=${e.published ?? '—'}`)
  }
  const ubuntuOut = outdated.filter(e => e.host === 'ubuntu').length
  const macosOut = outdated.length - ubuntuOut
  console.warn(`\n${entries.length} desktop package(s), ${outdated.length} out of date (${ubuntuOut} ubuntu-safe, ${macosOut} macos).`)

  // Publish out-of-date packages (requires storage creds in the env). Only the
  // packages for this run's build host — so the ubuntu-latest job publishes the
  // zip-only ones and the macos-latest job publishes the .dmg/macOS-tool ones.
  const toPublish = platform === 'all'
    ? outdated
    : outdated.filter(e => e.host === platform)
  if (doPublish && toPublish.length > 0) {
    console.warn(`\nPublishing ${toPublish.length} package(s) for host=${platform}.`)
    const failures: string[] = []
    for (const e of toPublish) {
      if (!e.latest)
        continue
      console.warn(`\n==> Publishing ${e.domain} @ ${e.latest}`)
      try {
        await $`./scripts/build-and-upload.sh ${e.domain} ${e.latest}`.cwd(ROOT)
        await verifyPublishedVersion(e.domain, e.latest)
      }
      catch (err) {
        console.error(`  ! failed to publish ${e.domain}: ${err}`)
        failures.push(`${e.domain}@${e.latest}`)
      }
    }
    if (failures.length > 0) {
      throw new Error(`desktop publication failed for ${failures.join(', ')}; manifest will not be committed`)
    }
  }

  const manifest = {
    generatedFromUpstreamAt: undefined as string | undefined, // stamped by CI, not here (keeps diffs clean)
    packages: entries.map(({ domain, name, kind, host, latest, published, needsUpdate }) => ({
      domain,
      name,
      kind,
      host,
      latest,
      published,
      needsUpdate,
    })),
  }
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`)
  console.warn(`Wrote ${MANIFEST}`)

  if (requireCurrent && outdated.length > 0) {
    const stale = outdated.map(e => `${e.domain} (${e.published ?? '—'} → ${e.latest})`).join(', ')
    throw new Error(`refusing to commit a stale desktop manifest: ${stale}`)
  }

  // Commit the manifest when it changed. The committer is chosen by the
  // WORKFLOW, not by this script. The final record job is the sole committer and
  // runs only after both native publish jobs succeed.
  if (doCommit) {
    const status = await $`git status --porcelain ${MANIFEST}`.cwd(ROOT).text()
    if (status.trim()) {
      const publishedChanges = entries
        .map(e => ({ ...e, previousPublished: previouslyPublished.get(e.domain) ?? null }))
        .filter(e => e.published && e.published !== e.previousPublished)
      const subject = commitSubject(publishedChanges)
      const body = publishedChanges.map(e =>
        `- ${e.kind} ${e.domain}: ${e.previousPublished ? `${e.previousPublished} → ${e.published}` : `published at ${e.published}`}`,
      ).join('\n')
      await $`git add ${MANIFEST}`.cwd(ROOT)
      await $`git commit -m ${subject} -m ${body || 'no version changes'}`.cwd(ROOT)
      console.warn(`Committed: ${subject}`)
    }
    else {
      console.warn('Manifest unchanged — nothing to commit.')
    }
  }
}

/** A precise, readable commit subject (no "(s)" hedging). */
export function commitSubject(published: Array<Entry & { previousPublished: string | null }>): string {
  if (published.length === 0)
    return 'chore(desktop): refresh version manifest'

  // Single update: name it exactly.
  if (published.length === 1) {
    const e = published[0]
    return e.previousPublished
      ? `chore(desktop): publish ${e.kind} ${e.domain} ${e.previousPublished} → ${e.published}`
      : `chore(desktop): publish ${e.kind} ${e.domain} ${e.published}`
  }

  // Several: count per kind ("2 apps & 1 font"), append names if they fit.
  const n = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`
  const apps = published.filter(e => e.kind === 'app').length
  const fonts = published.filter(e => e.kind === 'font').length
  const what = [apps && n(apps, 'app'), fonts && n(fonts, 'font')].filter(Boolean).join(' & ')

  let subject = `chore(desktop): publish ${what}`
  const names = published.map(e => e.domain).join(', ')
  if (`${subject} (${names})`.length <= 72)
    subject += ` (${names})`
  return subject
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
