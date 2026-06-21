#!/usr/bin/env bun
/**
 * check-desktop-updates.ts — keep the desktop app & font recipes fresh.
 *
 * For every desktop-app and font recipe, resolve the latest upstream version
 * (GitHub releases, per the recipe's versionSource) and compare it to the
 * version currently published in the pantry registry. It then:
 *   - writes a `desktop-versions.json` manifest (the committed record),
 *   - with `--commit`, commits that manifest when it changed,
 *   - with `--publish`, builds + uploads any out-of-date package via
 *     build-and-upload.sh (needs S3/registry creds in the env — Hetzner Object
 *     Storage: STORAGE_PROVIDER=hetzner + S3_* + S3_ACCESS_KEY_ID/SECRET).
 *
 *   bun scripts/check-desktop-updates.ts                 # report only
 *   bun scripts/check-desktop-updates.ts --commit        # + commit manifest
 *   bun scripts/check-desktop-updates.ts --publish --commit
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
import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { $ } from 'bun'

const ROOT = join(import.meta.dir, '..')
const RECIPES_DIR = join(ROOT, 'src', 'recipes')
const MANIFEST = join(ROOT, 'desktop-versions.json')
const REGISTRY = process.env.PANTRY_REGISTRY_URL || 'https://registry.pantry.dev'

const args = process.argv.slice(2)
const flags = new Set(args)
const doCommit = flags.has('--commit')
const doPublish = flags.has('--publish')

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

/** Tokens in a build script that genuinely require a macOS runner: mounting a
 * disk image, the macOS-only copy/resize tools, or the .pkg installer chain. */
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
function needsMacos(recipe: any): boolean {
  return MACOS_BUILD.test(buildScriptText(recipe))
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

async function publishedVersion(domain: string): Promise<string | null> {
  try {
    const res = await fetch(`${REGISTRY}/binaries/${encodeURI(domain)}/metadata.json`)
    if (!res.ok)
      return null
    return (await res.json() as any)?.latestVersion || null
  }
  catch {
    return null
  }
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
    const res = await fetch(`${REGISTRY}/desktop-apps`)
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
  // Build the candidate (file, kind) set: every font recipe + the app recipes
  // that back the registry's desktop-app catalogue.
  const candidates: Array<{ file: string, kind: 'app' | 'font' }> = []
  const seen = new Set<string>()
  const add = (file: string, kind: 'app' | 'font'): void => {
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

    const latest = repo ? await latestGithub(repo, tagPattern) : null
    const published = await publishedVersion(recipe.domain)
    entries.push({
      domain: recipe.domain,
      name: recipe.name ?? recipe.domain,
      kind,
      repo,
      latest,
      published,
      needsUpdate: !!latest && (latest !== published || forceDomains.has(recipe.domain)),
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

  // Publish out-of-date packages (requires storage creds in the env). Only the
  // packages for this run's build host — so the ubuntu-latest job publishes the
  // zip-only ones and the macos-latest job publishes the .dmg/macOS-tool ones.
  const toPublish = platform === 'all'
    ? outdated
    : outdated.filter(e => e.host === platform)
  if (doPublish && toPublish.length > 0) {
    console.warn(`\nPublishing ${toPublish.length} package(s) for host=${platform}.`)
    for (const e of toPublish) {
      if (!e.latest)
        continue
      console.warn(`\n==> Publishing ${e.domain} @ ${e.latest}`)
      try {
        await $`./scripts/build-and-upload.sh ${e.domain} ${e.latest}`.cwd(ROOT)
      }
      catch (err) {
        console.error(`  ! failed to publish ${e.domain}: ${err}`)
      }
    }
  }

  // Commit the manifest when it changed. In the split CI pipeline the ubuntu
  // job runs first and publishes its slice; the macos job runs after and is the
  // single committer — by then its fresh scan already reflects the ubuntu
  // publishes, so the one manifest commit is complete and the two jobs never
  // race on the commit/push. (`--platform=ubuntu` therefore skips committing.)
  if (doCommit && platform !== 'ubuntu') {
    const status = await $`git status --porcelain ${MANIFEST}`.cwd(ROOT).text()
    if (status.trim()) {
      const subject = commitSubject(outdated)
      const body = outdated.map(e =>
        `- ${e.kind} ${e.domain}: ${e.published ? `${e.published} → ${e.latest}` : `added at ${e.latest}`}`,
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
function commitSubject(outdated: Entry[]): string {
  if (outdated.length === 0)
    return 'chore(desktop): refresh version manifest'

  // Single update: name it exactly.
  if (outdated.length === 1) {
    const e = outdated[0]
    return e.published
      ? `chore(desktop): bump ${e.kind} ${e.domain} ${e.published} → ${e.latest}`
      : `chore(desktop): add ${e.kind} ${e.domain} ${e.latest}`
  }

  // Several: count per kind ("2 apps & 1 font"), append names if they fit.
  const n = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`
  const apps = outdated.filter(e => e.kind === 'app').length
  const fonts = outdated.filter(e => e.kind === 'font').length
  const what = [apps && n(apps, 'app'), fonts && n(fonts, 'font')].filter(Boolean).join(' & ')

  let subject = `chore(desktop): bump ${what}`
  const names = outdated.map(e => e.domain).join(', ')
  if (`${subject} (${names})`.length <= 72)
    subject += ` (${names})`
  return subject
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
