/**
 * How well a package was built, measured from the shipped bytes.
 *
 * Install size is decided twice: once by which packages are in the tree, and
 * again by how each one was built. The second half is invisible to every tool
 * that reports sizes, because a 2MB unminified bundle and a 2MB minified one
 * look identical from the outside — and the first is really a 1.5MB package
 * that nobody ran a minifier over.
 *
 * So this asks the questions a build config would answer:
 *
 *   - Would minifying this file make it smaller, and by how much? Measured by
 *     minifying it, not by guessing from line lengths — a bundle full of
 *     template literals has short lines and is already minified, and a
 *     "pretty" file with one enormous data literal has long ones and is not.
 *   - Do the entry points share chunks, or does each one inline the whole
 *     graph? Two entries that reach the same 1MB of library either cost 1MB or
 *     2MB depending on one `splitting` flag.
 *   - Is the same file shipped twice under different names?
 *
 * Every number here is bytes that would disappear from a published tarball
 * without removing a single feature.
 *
 * @module build-quality
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

export interface FileQuality {
  /** Path relative to the package root. */
  path: string
  bytes: number
  /** Bytes after whitespace minification, or `bytes` when it cannot be parsed. */
  minifiedBytes: number
  /** Whether the file could be parsed at all; unparseable files are reported as-is. */
  analyzed: boolean
}

export interface PackageQuality {
  name: string
  version: string
  path: string
  /** JavaScript bytes shipped. */
  jsBytes: number
  /** What those bytes would be if every file were minified. */
  minifiedBytes: number
  /** jsBytes - minifiedBytes: pure whitespace, shipped to every consumer. */
  minifiable: number
  /** Share of JS bytes that are already minified, 0-100. */
  minifiedPercent: number
  /** Files whose content is byte-identical to another file in the package. */
  duplicateBytes: number
  duplicateGroups: Array<{ bytes: number, paths: string[] }>
  /** Entry-point files (named in `exports`/`main`/`module`/`bin`). */
  entryCount: number
  /** Files that look like shared chunks, i.e. the build used code splitting. */
  chunkCount: number
  /**
   * Bytes the entries share with each other but do not import from a chunk.
   * A rough floor on what splitting would save: only counted when there are
   * two or more entries and no chunks at all.
   */
  unsharedEntryBytes: number
  worstFiles: FileQuality[]
}

export interface BuildQualityReport {
  projectRoot: string
  packages: PackageQuality[]
  totalJsBytes: number
  totalMinifiable: number
  totalDuplicate: number
  totalUnsharedEntry: number
}

const JS_FILE = /\.[cm]?js$/
const CHUNK_NAME = /(?:^|\/)chunk[-.][\w-]+\.[cm]?js$/

/**
 * Minified size of a source, measured by minifying it.
 *
 * Whitespace only: identifier and syntax minification would need a full build
 * graph, and the point is to report a floor a maintainer can act on by adding
 * one flag, not the best a bundler could theoretically do.
 */
function minifiedSize(source: string, transpiler: Bun.Transpiler): { bytes: number, analyzed: boolean } {
  try {
    return { bytes: transpiler.transformSync(source).length, analyzed: true }
  }
  catch {
    return { bytes: source.length, analyzed: false }
  }
}

function listJsFiles(dir: string, base: string, out: string[]): void {
  let entries: ReturnType<typeof readdirSync>
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  }
  catch {
    return
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue
      listJsFiles(full, base, out)
      continue
    }
    if (JS_FILE.test(entry.name)) out.push(relative(base, full))
  }
}

/** Paths named by `main`, `module`, `bin` or the `exports` map. */
function entryPaths(manifest: Record<string, unknown>): Set<string> {
  const found = new Set<string>()
  const add = (value: unknown): void => {
    if (typeof value === 'string' && JS_FILE.test(value))
      found.add(value.replace(/^\.\//, ''))
    else if (Array.isArray(value)) value.forEach(add)
    else if (value && typeof value === 'object') Object.values(value).forEach(add)
  }
  add(manifest.main)
  add(manifest.module)
  add(manifest.bin)
  add(manifest.exports)
  return found
}

export function analyzePackageBuild(dir: string, transpiler: Bun.Transpiler): PackageQuality | null {
  let manifest: Record<string, unknown>
  try {
    manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  }
  catch {
    return null
  }

  const files: string[] = []
  listJsFiles(dir, dir, files)
  if (files.length === 0) return null

  const entries = entryPaths(manifest)
  const byContent = new Map<string, string[]>()
  const qualities: FileQuality[] = []

  let jsBytes = 0
  let minifiedBytes = 0
  let chunkCount = 0
  let entryCount = 0
  let entryBytes = 0

  for (const path of files) {
    let source: string
    try {
      source = readFileSync(join(dir, path), 'utf8')
    }
    catch {
      continue
    }

    const { bytes: min, analyzed } = minifiedSize(source, transpiler)
    jsBytes += source.length
    minifiedBytes += min
    qualities.push({ path, bytes: source.length, minifiedBytes: min, analyzed })

    if (CHUNK_NAME.test(path)) chunkCount++
    if (entries.has(path)) {
      entryCount++
      entryBytes += source.length
    }

    const list = byContent.get(source)
    if (list) list.push(path)
    else byContent.set(source, [path])
  }

  const duplicateGroups: PackageQuality['duplicateGroups'] = []
  let duplicateBytes = 0
  for (const [source, paths] of byContent) {
    if (paths.length < 2) continue
    const wasted = source.length * (paths.length - 1)
    duplicateBytes += wasted
    duplicateGroups.push({ bytes: wasted, paths: paths.sort() })
  }
  duplicateGroups.sort((a, b) => b.bytes - a.bytes)

  // Several entries, no chunks: each one carries its own copy of whatever they
  // share. The smaller entries are the floor on what splitting would return.
  const unsharedEntryBytes = entryCount > 1 && chunkCount === 0
    ? entryBytes - Math.max(...qualities.filter(q => entries.has(q.path)).map(q => q.bytes), 0)
    : 0

  qualities.sort((a, b) => (b.bytes - b.minifiedBytes) - (a.bytes - a.minifiedBytes))

  return {
    name: String(manifest.name ?? dir),
    version: String(manifest.version ?? '0.0.0'),
    path: dir,
    jsBytes,
    minifiedBytes,
    minifiable: jsBytes - minifiedBytes,
    minifiedPercent: jsBytes > 0 ? Math.round((minifiedBytes / jsBytes) * 100) : 100,
    duplicateBytes,
    duplicateGroups: duplicateGroups.slice(0, 5),
    entryCount,
    chunkCount,
    unsharedEntryBytes,
    worstFiles: qualities.slice(0, 5),
  }
}

/**
 * Run the build-quality pass over an already-collected set of package
 * directories — the same real paths {@link analyzeNodeModules} found, so the
 * two reports describe the same install.
 */
export function analyzeBuildQuality(projectRoot: string, packageDirs: string[]): BuildQualityReport {
  const transpiler = new Bun.Transpiler({ loader: 'js', minifyWhitespace: true })
  const packages: PackageQuality[] = []

  for (const dir of packageDirs) {
    const quality = analyzePackageBuild(dir, transpiler)
    if (quality) packages.push(quality)
  }

  packages.sort((a, b) =>
    (b.minifiable + b.duplicateBytes + b.unsharedEntryBytes) - (a.minifiable + a.duplicateBytes + a.unsharedEntryBytes))

  return {
    projectRoot,
    packages,
    totalJsBytes: packages.reduce((sum, p) => sum + p.jsBytes, 0),
    totalMinifiable: packages.reduce((sum, p) => sum + p.minifiable, 0),
    totalDuplicate: packages.reduce((sum, p) => sum + p.duplicateBytes, 0),
    totalUnsharedEntry: packages.reduce((sum, p) => sum + p.unsharedEntryBytes, 0),
  }
}
