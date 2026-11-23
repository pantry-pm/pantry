#!/usr/bin/env bun
/**
 * Plan and apply ELF loader-path revisions (`revisionReasons: 'elf-loader-paths'`).
 *
 * Reads the results of scripts/audit-elf-rpaths.ts (its `--progress` JSONL),
 * picks every package whose newest Linux artifact carries a broken RPATH or
 * RUNPATH, orders them so libraries many packages depend on go first, and, for
 * a batch, writes the revision into the recipe, the revision identity into the
 * package's version list, and a row into the repair ledger. Pushing the result
 * lets publish-changed-packages mirror and normalise each one (Linux only).
 *
 *   bun scripts/elf-loader-revisions.ts plan  --audit audit.jsonl [--ledger L]
 *   bun scripts/elf-loader-revisions.ts apply --audit audit.jsonl --ledger L --batch 1 domain...
 *   bun scripts/elf-loader-revisions.ts mark  --ledger L --status published domain...
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { compareVersions } from '../src/generate-zig'
import { recipeBuildVersion, revisedPackageVersions, type PackageRevisions } from './package-revisions'

const tsPantry = resolve(import.meta.dir, '..')
const recipesDir = join(tsPantry, 'src', 'recipes')
const packagesDir = join(tsPantry, 'src', 'packages')

export interface AuditRow {
  domain: string
  version: string
  platform: string
  newestOnPlatform: boolean
  supersededBy?: string
  error?: string
  findings: Array<{ member: string, value: string, issues: string[] }>
  salvaged?: boolean
}

export interface Target {
  domain: string
  /** The upstream release the revision rebuilds. */
  version: string
  platforms: string[]
  issues: string[]
  members: string[]
}

export interface LedgerRow {
  domain: string
  oldBuild: string
  revision: string
  platforms: string[]
  batch: number | null
  status: 'pending' | 'published' | 'verified' | 'failed' | 'skipped'
  note?: string
}

export function readAudit(path: string): AuditRow[] {
  const rows = new Map<string, AuditRow>()
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue
    const row = JSON.parse(line) as AuditRow
    const key = `${row.domain}@${row.version} ${row.platform}`
    if (rows.has(key) && !rows.get(key)!.error && row.error) continue
    rows.set(key, row)
  }
  return [...rows.values()]
}

/** Packages whose newest Linux artifact is broken, by the newest broken version. */
export function brokenTargets(rows: readonly AuditRow[]): Target[] {
  const targets = new Map<string, Target>()
  for (const row of rows) {
    if (row.error || !row.newestOnPlatform) continue
    const bad = row.findings.filter(f => f.issues.length)
    if (!bad.length) continue
    const existing = targets.get(row.domain)
    if (existing && compareVersions(existing.version, row.version) < 0) {
      // compareVersions sorts newest first: a negative result means `existing` is newer.
      continue
    }
    const target = existing && existing.version === row.version
      ? existing
      : { domain: row.domain, version: row.version, platforms: [], issues: [], members: [] }
    target.platforms = [...new Set([...target.platforms, row.platform])].sort()
    target.issues = [...new Set([...target.issues, ...bad.flatMap(f => f.issues)])].sort()
    target.members = [...new Set([...target.members, ...bad.map(f => f.member)])].sort()
    targets.set(row.domain, target)
  }
  return [...targets.values()]
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      if (name !== 'props') walk(path, out)
    }
    else if (name.endsWith('.ts')) {
      out.push(path)
    }
  }
  return out
}

let packageIndex: Map<string, string> | undefined

export function packageFile(domain: string): string | undefined {
  if (!packageIndex) {
    packageIndex = new Map()
    for (const file of walk(packagesDir)) {
      const match = readFileSync(file, 'utf8').match(/\bdomain:\s*'([^']+)' as const/)
      if (match) packageIndex.set(match[1]!, file)
    }
  }
  return packageIndex.get(domain)
}

export function recipeFile(domain: string): string | undefined {
  const file = join(recipesDir, `${domain}.ts`)
  return existsSync(file) ? file : undefined
}

function arrayItems(source: string, field: string): string[] {
  const body = source.match(new RegExp(`\\b${field}:\\s*\\[([\\s\\S]*?)\\]\\s*as const`))?.[1]
  return body == null ? [] : [...body.matchAll(/['"]([^'"]+)['"]/g)].map(m => m[1]!)
}

/** How many catalog packages depend on each domain, directly. */
export function reverseDependencyCounts(): Map<string, number> {
  const counts = new Map<string, number>()
  for (const file of walk(packagesDir)) {
    for (const dep of arrayItems(readFileSync(file, 'utf8'), 'dependencies')) {
      const spec = dep.replace(/^(?:linux|darwin|windows):/, '')
      const domain = spec.split(/[\^~@<>=]/)[0]!.trim()
      counts.set(domain, (counts.get(domain) ?? 0) + 1)
    }
  }
  return counts
}

/** Core GNU tools and wide-fan-out libraries go first, whatever their counts. */
export const firstTier: readonly string[] = [
  'zlib.net', 'openssl.org', 'tukaani.org/xz', 'sourceware.org/bzip2', 'gnu.org/readline',
  'invisible-island.net/ncurses', 'sourceware.org/libffi', 'gnu.org/gettext', 'gnu.org/libiconv',
  'pcre.org/v2', 'pcre.org', 'sqlite.org', 'gnu.org/bash', 'gnu.org/coreutils', 'gnu.org/grep',
  'gnu.org/sed', 'gnu.org/tar', 'gnu.org/make', 'gnu.org/binutils', 'gnu.org/gmp', 'gnu.org/m4',
  'gnu.org/bison', 'gnu.org/gawk', 'gnu.org/findutils', 'gnu.org/diffutils', 'gnu.org/patch',
  'gnu.org/libtasn1', 'gnu.org/nettle', 'gnu.org/libidn', 'gnupg.org/libgpg-error', 'gnupg.org/libgcrypt',
  'libexpat.github.io', 'gnome.org/libxml2', 'kernel.org/libcap', 'savannah.nongnu.org/attr',
  'savannah.nongnu.org/acl', 'freedesktop.org/pkg-config', 'freedesktop.org/dbus', 'gnu.org/gdbm',
  'oracle.com/berkeley-db', 'c-ares.org', 'github.com/Cyan4973/xxHash', 'github.com/ebiggers/libdeflate',
]

export function orderTargets(targets: readonly Target[], counts: ReadonlyMap<string, number>, programs: (domain: string) => number): Target[] {
  const tier = (domain: string): number => {
    const index = firstTier.indexOf(domain)
    return index >= 0 ? index : firstTier.length
  }
  return [...targets].sort((a, b) =>
    tier(a.domain) - tier(b.domain)
    || (counts.get(b.domain) ?? 0) - (counts.get(a.domain) ?? 0)
    // Libraries before command-line tools, then by name.
    || programs(a.domain) - programs(b.domain)
    || a.domain.localeCompare(b.domain))
}

const numericTuple = /^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))+$/

/** The revision a target gets, or why it cannot get one. */
export function planRevision(target: Target, recipeSource: string, packageSource: string): { revision: string, revisions: PackageRevisions } | { blocked: string } {
  if (!numericTuple.test(target.version)) return { blocked: `version ${target.version} is not a numeric tuple, so it cannot carry a build revision` }
  const existing = parseRevisions(recipeSource)
  const current = existing[target.version] ?? 0
  if (current > 0 && !recipeSource.includes(`'${target.version}': 'elf-loader-paths'`))
    return { blocked: `revision ${target.version}.${current} already exists for another repair; a further one needs that recipe's own review` }
  const revisions = { ...existing, [target.version]: current + 1 }
  const versions = arrayItems(packageSource, 'versions')
  const upstream = [...new Set(versions.map(v => recipeBuildVersion(v, existing).upstream))]
  try { revisedPackageVersions(upstream, revisions) }
  catch (error) { return { blocked: (error as Error).message } }
  if (!versions.includes(target.version) && !versions.includes(`${target.version}.${current}`))
    return { blocked: `${target.version} is no longer in the catalog's version list` }
  return { revision: `${target.version}.${current + 1}`, revisions }
}

export function parseRevisions(recipeSource: string): Record<string, number> {
  const body = recipeSource.match(/^\s{2}revisions:\s*\{([^}]*)\}/m)?.[1]
  if (!body) return {}
  return Object.fromEntries([...body.matchAll(/['"]([^'"]+)['"]\s*:\s*(\d+)/g)].map(m => [m[1]!, Number(m[2])]))
}

function parseReasons(recipeSource: string): Record<string, string> {
  const body = recipeSource.match(/^\s{2}revisionReasons:\s*\{([^}]*)\}/m)?.[1]
  if (!body) return {}
  return Object.fromEntries([...body.matchAll(/['"]([^'"]+)['"]\s*:\s*['"]([^'"]+)['"]/g)].map(m => [m[1]!, m[2]!]))
}

function objectLiteral(entries: Record<string, string | number>): string {
  const items = Object.entries(entries).sort(([a], [b]) => compareVersions(a, b))
    .map(([key, value]) => `'${key}': ${typeof value === 'number' ? value : `'${value}'`}`)
  return `{ ${items.join(', ')} }`
}

/** The recipe with the revision and its reason declared. */
export function writeRecipeRevision(source: string, revisions: PackageRevisions, release: string): string {
  const reasons = { ...parseReasons(source), [release]: 'elf-loader-paths' }
  const revisionsLine = `  revisions: ${objectLiteral(revisions)},`
  const reasonsLine = `  revisionReasons: ${objectLiteral(reasons)},`
  let out = source
  out = /^\s{2}revisions:\s*\{[^}]*\},?$/m.test(out)
    ? out.replace(/^\s{2}revisions:\s*\{[^}]*\},?$/m, revisionsLine)
    : out.replace(/^(\s{2}name:\s*['"][^'"]*['"],)$/m, `$1\n${revisionsLine}`)
  out = /^\s{2}revisionReasons:\s*\{[^}]*\},?$/m.test(out)
    ? out.replace(/^\s{2}revisionReasons:\s*\{[^}]*\},?$/m, reasonsLine)
    : out.replace(revisionsLine, `${revisionsLine}\n${reasonsLine}`)
  if (!out.includes(revisionsLine) || !out.includes(reasonsLine)) throw new Error('recipe has no top-level `name:` line to anchor the revision on')
  return out
}

/** The package metadata with the revision identity ahead of the release it rebuilds. */
export function writePackageVersion(source: string, release: string, revision: string): string {
  if (arrayItems(source, 'versions').includes(revision)) return source
  const pattern = new RegExp(`^(\\s*)'${release.replace(/\./g, '\\.')}',$`, 'm')
  const match = source.match(/\bversions:\s*\[([\s\S]*?)\]\s*as const/)
  if (!match) throw new Error('package has no versions list')
  const start = match.index! + match[0].indexOf('[')
  const end = match.index! + match[0].lastIndexOf(']')
  const body = source.slice(start, end)
  if (!pattern.test(body)) throw new Error(`${release} is not in the versions list`)
  return source.slice(0, start) + body.replace(pattern, `$1'${revision}',\n$1'${release}',`) + source.slice(end)
}

export function readLedger(path: string): LedgerRow[] {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')).packages : []
}

export function writeLedger(path: string, rows: readonly LedgerRow[]): void {
  const sorted = [...rows].sort((a, b) => (a.batch ?? 1e9) - (b.batch ?? 1e9) || a.domain.localeCompare(b.domain))
  const summary: Record<string, number> = {}
  for (const row of sorted) summary[row.status] = (summary[row.status] ?? 0) + 1
  writeFileSync(path, `${JSON.stringify({
    description: 'Linux artifacts whose ELF RPATH/RUNPATH lost $ORIGIN, repaired by elf-loader-paths revisions (scripts/elf-loader-revisions.ts, audited with scripts/audit-elf-rpaths.ts).',
    summary,
    packages: sorted,
  }, null, 2)}\n`)
}

function programCount(domain: string): number {
  const file = packageFile(domain)
  return file ? arrayItems(readFileSync(file, 'utf8'), 'programs').length : 0
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2)
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      audit: { type: 'string' },
      ledger: { type: 'string', default: resolve(tsPantry, '../../docs/elf-loader-repair.json') },
      batch: { type: 'string' },
      status: { type: 'string' },
      note: { type: 'string' },
    },
  })
  const ledgerPath = values.ledger!
  const ledger = readLedger(ledgerPath)

  if (command === 'mark') {
    for (const domain of positionals) {
      const row = ledger.find(r => r.domain === domain)
      if (!row) throw new Error(`${domain} is not in the ledger`)
      row.status = values.status as LedgerRow['status']
      if (values.note) row.note = values.note
    }
    writeLedger(ledgerPath, ledger)
    return
  }

  if (!values.audit) throw new Error('--audit <progress.jsonl> is required')
  const targets = brokenTargets(readAudit(values.audit))

  if (command === 'plan') {
    const done = new Set(ledger.map(r => r.domain))
    const ordered = orderTargets(targets.filter(t => !done.has(t.domain)), reverseDependencyCounts(), programCount)
    for (const t of ordered) console.log(`${t.domain}@${t.version} ${t.platforms.join(',')} ${t.issues.join(',')}`)
    return
  }

  if (command === 'apply') {
    const batch = Number(values.batch)
    for (const domain of positionals) {
      const target = targets.find(t => t.domain === domain)
      if (!target) throw new Error(`${domain} has no broken newest Linux artifact in the audit`)
      const recipe = recipeFile(domain)
      const pkg = packageFile(domain)
      if (!recipe || !pkg) throw new Error(`${domain}: recipe or package metadata missing`)
      const recipeSource = readFileSync(recipe, 'utf8')
      const packageSource = readFileSync(pkg, 'utf8')
      const plan = planRevision(target, recipeSource, packageSource)
      const row: LedgerRow = { domain, oldBuild: target.version, revision: '', platforms: target.platforms, batch, status: 'pending' }
      if ('blocked' in plan) {
        row.status = 'skipped'
        row.note = plan.blocked
        console.log(`skip ${domain}: ${plan.blocked}`)
      }
      else {
        writeFileSync(recipe, writeRecipeRevision(recipeSource, plan.revisions, target.version))
        writeFileSync(pkg, writePackageVersion(packageSource, target.version, plan.revision))
        row.revision = plan.revision
        console.log(`${domain}: ${target.version} -> ${plan.revision}`)
      }
      const index = ledger.findIndex(r => r.domain === domain)
      if (index >= 0) ledger[index] = row
      else ledger.push(row)
    }
    writeLedger(ledgerPath, ledger)
    return
  }

  throw new Error('usage: elf-loader-revisions.ts plan|apply|mark ...')
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`elf-loader-revisions: ${(error as Error).message}`)
    process.exit(1)
  })
}
