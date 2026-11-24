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
 *   bun scripts/elf-loader-revisions.ts classify --audit audit.jsonl --needed needed.jsonl [--write]
 *   bun scripts/elf-loader-revisions.ts inplace [--audit audit.jsonl --batch N] [--since ISO] [--reason R] domain...
 *   bun scripts/elf-loader-revisions.ts defer --audit audit.jsonl [--note N] [--reason R] domain...
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { compareVersions } from '../src/generate-zig'
import { recipeBuildVersion, revisedPackageVersions, revisionIdentity, type PackageRevisions } from './package-revisions'

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
  /** From an audit that records DT_NEEDED: libraries the host does not provide. */
  needed?: string[]
  sharedLibraries?: number
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
  status: 'pending' | 'published' | 'verified' | 'failed' | 'skipped' | 'next-release'
  note?: string
  /**
   * How the repair reaches clients. `revision`: a new build identity
   * (`X.N`, `X.pantryN`). `in-place`: the artifact of `oldBuild` itself is
   * replaced (build-all-packages --repair-in-place) and clients refetch on
   * its sha256 change. Rows written before this field are revisions.
   */
  method?: 'revision' | 'in-place'
  /** Why the package was or was not repaired now (popularity evidence). */
  reason?: string
  /**
   * The in-place overwrite of `oldBuild`: the whole repair for an `in-place`
   * row, and the backward repair of a `revision` row, so exact pins and older
   * locks get correct bytes too. `since` is when it was requested; a served
   * artifact uploaded after it is the replacement.
   */
  inPlace?: { status: 'pending' | 'published' | 'verified' | 'failed', since: string, note?: string }
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

/** The revision a target gets, or why it cannot get one. */
export function planRevision(target: Target, recipeSource: string, packageSource: string): { revision: string, revisions: PackageRevisions } | { blocked: string } {
  const existing = parseRevisions(recipeSource)
  const current = existing[target.version] ?? 0
  if (current > 0 && !recipeSource.includes(`'${target.version}': 'elf-loader-paths'`))
    return { blocked: `revision ${revisionIdentity(target.version, current)} already exists for another repair; a further one needs that recipe's own review` }
  const revisions = { ...existing, [target.version]: current + 1 }
  const versions = arrayItems(packageSource, 'versions')
  const upstream = [...new Set(versions.map(v => recipeBuildVersion(v, existing).upstream))]
  try { revisedPackageVersions(upstream, revisions) }
  catch (error) { return { blocked: (error as Error).message } }
  if (!versions.includes(target.version) && !(current > 0 && versions.includes(revisionIdentity(target.version, current))))
    return { blocked: `${target.version} is no longer in the catalog's version list` }
  return { revision: revisionIdentity(target.version, current + 1), revisions }
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

/**
 * The recipe without the loader-path revision of `release`: a revision that
 * never published, withdrawn so the catalog does not advertise it and the
 * pipeline stops rebuilding it. Other revisions and reasons stay.
 */
export function removeRecipeRevision(source: string, release: string): string {
  const revisions = parseRevisions(source)
  const reasons = parseReasons(source)
  if (!(release in revisions)) return source
  if (reasons[release] !== 'elf-loader-paths') throw new Error(`${release} is not an elf-loader-paths revision`)
  delete revisions[release]
  delete reasons[release]
  let out = source
  out = Object.keys(revisions).length
    ? out.replace(/^\s{2}revisions:\s*\{[^}]*\},?$/m, `  revisions: ${objectLiteral(revisions)},`)
    : out.replace(/^\s{2}revisions:\s*\{[^}]*\},?\n/m, '')
  out = Object.keys(reasons).length
    ? out.replace(/^\s{2}revisionReasons:\s*\{[^}]*\},?$/m, `  revisionReasons: ${objectLiteral(reasons)},`)
    : out.replace(/^\s{2}revisionReasons:\s*\{[^}]*\},?\n/m, '')
  return out
}

/** The package metadata without a withdrawn revision identity. */
export function removePackageVersion(source: string, revision: string): string {
  return source.replace(new RegExp(`^\\s*'${revision.replace(/\./g, '\\.')}',\\n`, 'm'), '')
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

/**
 * Why a broken loader path cannot matter, or why it can.
 *
 * `/../lib` (an `$ORIGIN` expanded away) resolves to `/lib`, a root-owned host
 * directory. A binary that needs nothing beyond the host's own libc, libstdc++
 * and libgcc_s, ships no private library and installs no runtime dependency
 * never finds anything through that entry it would not find without it, so
 * rebuilding it changes nothing. An empty or relative entry searches the
 * working directory, and is always repaired.
 */
export function classifyTarget(
  target: Target,
  rows: readonly AuditRow[],
  runtimeDependencies: readonly string[],
): { harmless: true, reason: string } | { harmless: false, reason: string } {
  const audited = target.platforms.map(platform => rows.find(r => r.domain === target.domain && r.version === target.version && r.platform === platform && !r.error && !r.salvaged && r.needed))
  if (audited.some(r => !r)) return { harmless: false, reason: 'not audited with DT_NEEDED' }
  const issues = new Set(audited.flatMap(r => r!.findings.flatMap(f => f.issues)))
  const unsafe = [...issues].filter(issue => issue !== 'expanded-origin')
  if (unsafe.length) return { harmless: false, reason: `${unsafe.join(',')} entries search the working directory` }
  const needed = [...new Set(audited.flatMap(r => r!.needed!))].sort()
  if (needed.length) return { harmless: false, reason: `needs ${needed.join(', ')}` }
  if (audited.some(r => (r!.sharedLibraries ?? 1) > 0)) return { harmless: false, reason: 'ships private shared libraries' }
  if (runtimeDependencies.length) return { harmless: false, reason: `installs runtime dependencies (${runtimeDependencies.join(', ')})` }
  return {
    harmless: true,
    reason: `only expanded-$ORIGIN entries (resolve to /lib) on ${target.platforms.join(',')}; needs nothing beyond the host libc/libstdc++/libgcc_s, ships no private library, has no runtime dependency`,
  }
}

export function runtimeDependencies(domain: string): string[] {
  const file = packageFile(domain)
  return file ? arrayItems(readFileSync(file, 'utf8'), 'dependencies').filter(dep => !/^(?:darwin|windows):/.test(dep)) : []
}

export function readLedger(path: string): LedgerRow[] {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')).packages : []
}

export function writeLedger(path: string, rows: readonly LedgerRow[]): void {
  const sorted = [...rows].sort((a, b) => (a.batch ?? 1e9) - (b.batch ?? 1e9) || a.domain.localeCompare(b.domain))
  const summary: Record<string, number> = {}
  for (const row of sorted) summary[row.status] = (summary[row.status] ?? 0) + 1
  writeFileSync(path, `${JSON.stringify({
    description: 'Linux artifacts whose ELF RPATH/RUNPATH lost $ORIGIN (scripts/audit-elf-rpaths.ts). method revision: repaired as a new build identity; method in-place: the artifact of oldBuild replaced under its own version (build-all-packages --repair-in-place), clients refetch on its sha256 change. inPlace records the in-place overwrite, also done backward for revision rows. next-release: left to its next upstream build, which the pipeline normalises. Driven by scripts/elf-loader-revisions.ts.',
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
      needed: { type: 'string' },
      write: { type: 'boolean', default: false },
      since: { type: 'string' },
      reason: { type: 'string' },
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

  if (command === 'check') {
    // Which revisions the registry now serves on every platform their base was on.
    for (const row of ledger) {
      if (!row.revision || (row.status !== 'pending' && row.status !== 'published')) continue
      const response = await fetch(`https://registry.pantry.dev/binaries/${row.domain}/metadata.json`)
      if (!response.ok) continue
      const metadata = await response.json() as { versions?: Record<string, { platforms?: Record<string, { sha256?: string }> }> }
      const base = Object.keys(metadata.versions?.[row.oldBuild]?.platforms ?? {})
      const wanted = base.filter(p => p.startsWith('linux-') || row.note?.startsWith('corrupt-archive')).filter(p => p !== 'darwin-x86-64')
      const served = Object.entries(metadata.versions?.[row.revision]?.platforms ?? {}).filter(([, r]) => r.sha256).map(([p]) => p)
      const missing = wanted.filter(p => !served.includes(p))
      if (!missing.length && row.status === 'pending') row.status = 'published'
      console.log(`${row.domain}@${row.revision}: ${missing.length ? `missing ${missing.join(',')}` : 'served'} (${row.status})`)
    }
    // In-place overwrites: every broken platform `oldBuild` is served on now
    // carries an artifact uploaded after the request.
    for (const row of ledger) {
      if (row.inPlace?.status !== 'pending') continue
      const response = await fetch(`https://registry.pantry.dev/binaries/${row.domain}/metadata.json`)
      if (!response.ok) continue
      const metadata = await response.json() as { versions?: Record<string, { platforms?: Record<string, { sha256?: string, uploadedAt?: string }> }> }
      // The broken platforms are the ones to replace; a sound one need not move.
      const platforms = Object.entries(metadata.versions?.[row.oldBuild]?.platforms ?? {}).filter(([p]) => row.platforms.includes(p))
      const stale = platforms.filter(([, r]) => !r.uploadedAt || r.uploadedAt < row.inPlace!.since).map(([p]) => p)
      if (platforms.length && !stale.length) {
        row.inPlace.status = 'published'
        if (row.method === 'in-place' && row.status === 'pending') row.status = 'published'
      }
      console.log(`${row.domain}@${row.oldBuild} in place: ${stale.length ? `not yet on ${stale.join(',')}` : 'replaced'} (${row.inPlace.status})`)
    }
    writeLedger(ledgerPath, ledger)
    return
  }

  if (command === 'inplace') {
    // Request in-place overwrites of each domain's `oldBuild` (a revision row's
    // backward repair, or a new in-place row with --audit and --batch).
    const since = values.since ?? new Date().toISOString()
    const targets = values.audit ? brokenTargets(readAudit(values.audit)) : []
    for (const domain of positionals) {
      let row = ledger.find(r => r.domain === domain)
      if (!row) {
        const target = targets.find(t => t.domain === domain)
        if (!target) throw new Error(`${domain} is neither in the ledger nor a broken target in --audit`)
        row = { domain, oldBuild: target.version, revision: '', platforms: target.platforms, batch: values.batch ? Number(values.batch) : null, status: 'pending', method: 'in-place' }
        ledger.push(row)
      }
      row.method ??= row.revision ? 'revision' : 'in-place'
      if (values.reason) row.reason = values.reason
      row.inPlace = { status: 'pending', since }
      if (row.method === 'in-place') {
        row.status = 'pending'
        delete row.note
      }
      console.log(`${domain}@${row.oldBuild}`)
    }
    writeLedger(ledgerPath, ledger)
    return
  }

  if (command === 'withdraw') {
    // Withdraw unpublished loader-path revisions, leaving the package to its
    // next upstream release (`next-release`, with --note/--reason).
    for (const domain of positionals) {
      const row = ledger.find(r => r.domain === domain)
      if (!row?.revision) throw new Error(`${domain} has no revision in the ledger`)
      if (row.status === 'published' || row.status === 'verified') throw new Error(`${domain}@${row.revision} is published; it stays`)
      const recipe = recipeFile(domain)
      const pkg = packageFile(domain)
      if (recipe) writeFileSync(recipe, removeRecipeRevision(readFileSync(recipe, 'utf8'), row.oldBuild))
      if (pkg) writeFileSync(pkg, removePackageVersion(readFileSync(pkg, 'utf8'), row.revision))
      row.note = `${values.note ?? 'fixed on next release'} (revision ${row.revision} withdrawn unpublished${row.note ? `; last failure: ${row.note}` : ''})`
      row.revision = ''
      row.status = 'next-release'
      if (values.reason) row.reason = values.reason
      console.log(`${domain}: withdrawn`)
    }
    writeLedger(ledgerPath, ledger)
    return
  }

  if (command === 'defer') {
    // Track targets left to their next upstream release, which the pipeline
    // builds with normalised loader paths and checked programs anyway.
    if (!values.audit) throw new Error('--audit <progress.jsonl> is required')
    const targets = brokenTargets(readAudit(values.audit))
    const listed = new Set(positionals)
    for (const target of targets) {
      if (!listed.has(target.domain) || ledger.some(r => r.domain === target.domain)) continue
      ledger.push({ domain: target.domain, oldBuild: target.version, revision: '', platforms: target.platforms, batch: null, status: 'next-release', note: values.note ?? 'fixed on next release', ...(values.reason ? { reason: values.reason } : {}) })
    }
    writeLedger(ledgerPath, ledger)
    return
  }

  if (command === 'confirm') {
    // A published revision is verified once a re-audit of its own artifacts
    // (audit-elf-rpaths.ts --scope newest) finds no broken loader path.
    if (!values.audit) throw new Error('--audit <re-audit progress.jsonl> is required')
    const rows = readAudit(values.audit) as Array<AuditRow & { executables?: string[] }>
    const judge = (row: LedgerRow, audited: Array<AuditRow & { executables?: string[] }>): { status: 'verified' | 'failed', note?: string } => {
      const bad = audited.filter(r => r.findings.some(f => f.issues.length))
      const file = packageFile(row.domain)
      const [major = '', minor = '', patch = ''] = row.oldBuild.split('.')
      const declared = (file ? arrayItems(readFileSync(file, 'utf8'), 'programs') : [])
        .map(p => p.replace(/\{\{\s*version\.major\s*\}\}/g, major).replace(/\{\{\s*version\.minor\s*\}\}/g, minor)
          .replace(/\{\{\s*version\.patch\s*\}\}/g, patch).replace(/\{\{\s*version(?:\.raw)?\s*\}\}/g, row.oldBuild))
        .filter(p => !p.includes('{{'))
      const lacking = audited.flatMap(r => r.executables ? declared.filter(p => !r.executables!.includes(p)).map(p => `${p} (${r.platform})`) : [])
      if (bad.length) return { status: 'failed', note: `re-audit still finds broken loader paths on ${bad.map(r => r.platform).join(',')}` }
      if (lacking.length) return { status: 'failed', note: `the replacement lacks declared programs: ${lacking.join(', ')}` }
      return { status: 'verified' }
    }
    // In-place overwrites: the re-audit must have read the replacement itself.
    for (const row of ledger) {
      if (row.inPlace?.status !== 'published' && !(values.status === 'recheck' && row.inPlace?.status === 'verified')) continue
      const audited = rows.filter(r => r.domain === row.domain && r.version === row.oldBuild && !r.error && (r as AuditRow & { uploadedAt?: string }).uploadedAt! >= row.inPlace!.since)
      if (!audited.length) continue
      const verdict = judge(row, audited)
      row.inPlace.status = verdict.status
      if (verdict.note) row.inPlace.note = verdict.note
      else delete row.inPlace.note
      if (row.method === 'in-place') {
        row.status = verdict.status
        if (verdict.note) row.note = verdict.note
      }
      console.log(`${row.domain}@${row.oldBuild} in place: ${verdict.status}`)
    }
    for (const row of ledger) {
      if (row.method === 'in-place') continue
      if (row.status !== 'published' && !(values.status === 'recheck' && row.status === 'verified')) continue
      const audited = rows.filter(r => r.domain === row.domain && r.version === row.revision && !r.error)
      if (!audited.length) continue
      const bad = audited.filter(r => r.findings.some(f => f.issues.length))
      // A mirrored vendor build can lack programs the recipe's own build had
      // (coreutils' chcon and runcon); every client checks declared programs.
      const file = packageFile(row.domain)
      // Program names can be templated on the release (gawk's `gawk-{{version}}`).
      const [major = '', minor = '', patch = ''] = row.oldBuild.split('.')
      const declared = (file ? arrayItems(readFileSync(file, 'utf8'), 'programs') : [])
        .map(p => p.replace(/\{\{\s*version\.major\s*\}\}/g, major).replace(/\{\{\s*version\.minor\s*\}\}/g, minor)
          .replace(/\{\{\s*version\.patch\s*\}\}/g, patch).replace(/\{\{\s*version(?:\.raw)?\s*\}\}/g, row.oldBuild))
        .filter(p => !p.includes('{{'))
      const lacking = audited.flatMap(r => r.executables ? declared.filter(p => !r.executables!.includes(p)).map(p => `${p} (${r.platform})`) : [])
      if (bad.length) {
        row.status = 'failed'
        row.note = `re-audit still finds broken loader paths on ${bad.map(r => r.platform).join(',')}`
      }
      else if (lacking.length) {
        row.status = 'failed'
        row.note = `the revision lacks declared programs: ${lacking.join(', ')}`
      }
      else {
        row.status = 'verified'
        if (row.note?.startsWith('the revision lacks') || row.note?.startsWith('re-audit still')) delete row.note
      }
      console.log(`${row.domain}@${row.revision}: ${row.status}`)
    }
    writeLedger(ledgerPath, ledger)
    return
  }

  if (!values.audit) throw new Error('--audit <progress.jsonl> is required')
  const targets = brokenTargets(readAudit(values.audit))

  if (command === 'classify') {
    // --needed: a re-audit (audit-elf-rpaths.ts) of the targets that records DT_NEEDED.
    if (!values.needed) throw new Error('--needed <audit progress.jsonl with DT_NEEDED> is required')
    const neededRows = readAudit(values.needed)
    const done = new Set(ledger.map(r => r.domain))
    for (const target of targets.filter(t => !done.has(t.domain))) {
      const verdict = classifyTarget(target, neededRows, runtimeDependencies(target.domain))
      console.log(`${verdict.harmless ? 'harmless' : 'repair'} ${target.domain}@${target.version}: ${verdict.reason}`)
      if (verdict.harmless && values.write)
        ledger.push({ domain: target.domain, oldBuild: target.version, revision: '', platforms: target.platforms, batch: null, status: 'skipped', note: `false positive: ${verdict.reason}` })
    }
    if (values.write) writeLedger(ledgerPath, ledger)
    return
  }

  if (command === 'plan') {
    const done = new Set(ledger.map(r => r.domain))
    const ordered = orderTargets(targets.filter(t => !done.has(t.domain)), reverseDependencyCounts(), programCount)
    for (const t of ordered) console.log(`${t.domain}@${t.version} ${t.platforms.join(',')} ${t.issues.join(',')}`)
    return
  }

  if (command === 'apply') {
    const batch = Number(values.batch)
    const rows = readAudit(values.audit)
    for (const selector of positionals) {
      // `domain@version` repairs that release even when it is not the newest,
      // such as a broken newest prerelease beside a sound stable release.
      const [domain, version] = selector.includes('@') ? [selector.slice(0, selector.lastIndexOf('@')), selector.slice(selector.lastIndexOf('@') + 1)] : [selector, undefined]
      const target = version
        ? brokenTargets(rows.filter(r => r.domain === domain && r.version === version).map(r => ({ ...r, newestOnPlatform: true })))[0]
        : targets.find(t => t.domain === domain)
      if (!target) throw new Error(`${selector} has no broken Linux artifact in the audit`)
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
