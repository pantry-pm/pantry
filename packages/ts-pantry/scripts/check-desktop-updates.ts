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

const flags = new Set(process.argv.slice(2))
const doCommit = flags.has('--commit')
const doPublish = flags.has('--publish')

interface Entry {
  domain: string
  name: string
  kind: 'app' | 'font'
  repo: string | null
  latest: string | null
  published: string | null
  needsUpdate: boolean
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
  for (const file of listFontRecipes(RECIPES_DIR))
    candidates.push({ file, kind: 'font' })
  for (const domain of await appDomains()) {
    if (domain.includes('/'))
      continue // slash-domains stay in their own nested path; skip here
    const file = findRecipeFile(RECIPES_DIR, `${domain}.ts`)
    if (file)
      candidates.push({ file, kind: 'app' })
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
      needsUpdate: !!latest && latest !== published,
    })
  }

  entries.sort((a, b) => a.domain.localeCompare(b.domain))
  const outdated = entries.filter(e => e.needsUpdate)

  // Report.
  for (const e of entries) {
    const mark = e.needsUpdate ? '⬆' : (e.published ? '✓' : '·')
    console.warn(`  ${mark} ${e.domain.padEnd(34)} latest=${e.latest ?? '?'} published=${e.published ?? '—'}`)
  }
  console.warn(`\n${entries.length} desktop package(s), ${outdated.length} out of date.`)

  const manifest = {
    generatedFromUpstreamAt: undefined as string | undefined, // stamped by CI, not here (keeps diffs clean)
    packages: entries.map(({ domain, name, kind, latest, published, needsUpdate }) => ({
      domain,
      name,
      kind,
      latest,
      published,
      needsUpdate,
    })),
  }
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`)
  console.warn(`Wrote ${MANIFEST}`)

  // Publish out-of-date packages (requires storage creds in the env).
  if (doPublish && outdated.length > 0) {
    for (const e of outdated) {
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

  // Commit the manifest when it changed.
  if (doCommit) {
    const status = await $`git status --porcelain ${MANIFEST}`.cwd(ROOT).text()
    if (status.trim()) {
      const subject = outdated.length > 0
        ? `chore(desktop): ${outdated.length} app/font version update(s)`
        : 'chore(desktop): refresh version manifest'
      const body = outdated.map(e => `- ${e.domain}: ${e.published ?? '—'} → ${e.latest}`).join('\n')
      await $`git add ${MANIFEST}`.cwd(ROOT)
      await $`git commit -m ${subject} -m ${body || 'no version changes'}`.cwd(ROOT)
      console.warn(`Committed: ${subject}`)
    }
    else {
      console.warn('Manifest unchanged — nothing to commit.')
    }
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
