/**
 * node_modules inspector — what an install actually costs, and why.
 *
 * A package manager reports what it resolved. This reports what landed on
 * disk, which is a different number and the one that matters: nested copies of
 * a dependency that a version range refused to share, tarballs that shipped
 * their own `src/` and test suite next to the build output, a 7MB SDK behind a
 * code path nothing calls.
 *
 * The question it is built to answer is not "how big is this package" — every
 * tool answers that — but "how much of this install would disappear if this
 * one edge were cut". A package that is 200KB on its own and the sole reason
 * 40MB of transitive dependencies are present is a 40MB decision, and no
 * self-size column will ever say so.
 *
 * Zero runtime dependencies beyond Bun builtins.
 *
 * @module node-modules
 */

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'

export interface Manifest {
  name?: string
  version?: string
  description?: string
  license?: string
  homepage?: string
  repository?: unknown
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
  optionalDependencies?: Record<string, string>
  bin?: Record<string, string> | string
  files?: string[]
  type?: string
  exports?: unknown
}

/** Bytes on disk, split the way the questions get asked. */
export interface SizeBreakdown {
  /** Everything under the package directory, excluding nested `node_modules`. */
  self: number
  /** `self` plus every nested `node_modules` inside it. */
  withNested: number
  /** File count behind `self`. */
  files: number
  /** Bytes by category: what is actually in there. */
  code: number
  types: number
  sourceMaps: number
  docs: number
  assets: number
  other: number
}

/** Something in the tarball that has no business being installed. */
export interface HygieneFinding {
  kind: 'ships-source' | 'ships-tests' | 'ships-ci' | 'ships-lockfile' | 'ships-editor-config' | 'no-files-field'
  detail: string
  bytes: number
}

export interface PackageNode {
  /** Unique per install location, since one name can be installed many times. */
  id: string
  name: string
  version: string
  /** Path relative to the project root. */
  path: string
  /** How deeply nested in `node_modules/.../node_modules/...` this copy is. */
  nesting: number
  description?: string
  license?: string
  homepage?: string
  deps: string[]
  devDeps: string[]
  peerDeps: string[]
  optionalPeerDeps: string[]
  hasBin: boolean
  size: SizeBreakdown
  hygiene: HygieneFinding[]
  /** Names that resolve to this node from anywhere in the tree. */
  dependents: string[]
  /** Shortest number of edges from a root dependency. 0 = a root dependency. */
  depth: number
  /** Packages reachable from here, excluding itself. */
  transitive: number
  /**
   * Bytes that leave the install if every edge into this package is cut.
   * Its own size plus everything reachable only through it.
   */
  exclusiveBytes: number
}

/** One name installed more than once, and what the extra copies cost. */
export interface DuplicateGroup {
  name: string
  copies: Array<{ version: string, path: string, bytes: number }>
  /** Bytes in every copy after the largest — what deduping would return. */
  wastedBytes: number
}

export interface NodeModulesAnalysis {
  projectRoot: string
  projectName: string
  generatedAt: string
  totalBytes: number
  totalPackages: number
  /** Distinct package names, ignoring duplicate installs. */
  distinctNames: number
  maxDepth: number
  rootDependencies: string[]
  rootDevDependencies: string[]
  packages: PackageNode[]
  duplicates: DuplicateGroup[]
  hygiene: Array<{ name: string, version: string, path: string, findings: HygieneFinding[], bytes: number }>
  /** Sizes rolled up by category across the whole tree. */
  categoryTotals: Pick<SizeBreakdown, 'code' | 'types' | 'sourceMaps' | 'docs' | 'assets' | 'other'>
  /** Biggest single wins, ranked by exclusive cost. */
  topByExclusive: Array<{ name: string, exclusiveBytes: number, selfBytes: number, dependents: number }>
  topBySelf: Array<{ name: string, bytes: number, path: string }>
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(2)} GB`
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

const TYPE_EXTENSIONS = /\.d\.[cm]?ts$/
const CODE_EXTENSIONS = /\.([cm]?[jt]sx?|wasm)$/
const MAP_EXTENSIONS = /\.map$/
const DOC_EXTENSIONS = /\.(md|markdown|txt|rst)$/i
const ASSET_EXTENSIONS = /\.(css|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|eot|json|ya?ml|html?)$/i

function categorize(filename: string): keyof Pick<SizeBreakdown, 'code' | 'types' | 'sourceMaps' | 'docs' | 'assets' | 'other'> {
  if (TYPE_EXTENSIONS.test(filename)) return 'types'
  if (MAP_EXTENSIONS.test(filename)) return 'sourceMaps'
  if (CODE_EXTENSIONS.test(filename)) return 'code'
  if (DOC_EXTENSIONS.test(filename)) return 'docs'
  if (ASSET_EXTENSIONS.test(filename)) return 'assets'
  return 'other'
}

/**
 * Directory names that mean a package published its working tree.
 *
 * Being in the tarball is the problem, not being in the repository: `files`
 * (or the lack of it) decided this, and every consumer downloads and stores
 * the result. `src/` next to `dist/` is the common one and usually doubles the
 * package.
 */
const HYGIENE_DIRS: Array<{ names: string[], kind: HygieneFinding['kind'], label: string }> = [
  { names: ['src', 'source'], kind: 'ships-source', label: 'source next to build output' },
  { names: ['test', 'tests', '__tests__', 'spec', 'e2e'], kind: 'ships-tests', label: 'test suite' },
  { names: ['.github', '.gitlab', '.circleci'], kind: 'ships-ci', label: 'CI configuration' },
  { names: ['.vscode', '.idea'], kind: 'ships-editor-config', label: 'editor configuration' },
]

const HYGIENE_FILES: Array<{ names: string[], kind: HygieneFinding['kind'], label: string }> = [
  {
    names: ['bun.lock', 'bun.lockb', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'],
    kind: 'ships-lockfile',
    label: 'lockfile',
  },
]

interface ScanResult extends SizeBreakdown {
  /** Immediate child directory names, for the hygiene pass. */
  topLevelDirs: string[]
  topLevelFiles: string[]
  /** Bytes per immediate child, so a finding can say what it costs. */
  childBytes: Record<string, number>
}

/**
 * Measure one package directory.
 *
 * Nested `node_modules` are measured separately rather than skipped: they are
 * real bytes on disk and belong to whoever forced the nesting, but folding
 * them into `self` would make a package look bloated when the fault is a
 * version range somewhere else.
 */
function scanPackage(dir: string): ScanResult {
  const result: ScanResult = {
    self: 0,
    withNested: 0,
    files: 0,
    code: 0,
    types: 0,
    sourceMaps: 0,
    docs: 0,
    assets: 0,
    other: 0,
    topLevelDirs: [],
    topLevelFiles: [],
    childBytes: {},
  }

  const walk = (current: string, depth: number, child: string | null): void => {
    let entries: ReturnType<typeof readdirSync>
    try {
      entries = readdirSync(current, { withFileTypes: true })
    }
    catch {
      return
    }

    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isSymbolicLink()) continue

      const childKey = depth === 0 ? entry.name : child

      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') {
          const nested = directoryBytes(full)
          result.withNested += nested
          continue
        }
        if (depth === 0) result.topLevelDirs.push(entry.name)
        walk(full, depth + 1, childKey)
        continue
      }

      let size = 0
      try {
        size = statSync(full).size
      }
      catch {
        continue
      }

      if (depth === 0) result.topLevelFiles.push(entry.name)
      result.self += size
      result.withNested += size
      result.files++
      result[categorize(entry.name)] += size
      if (childKey) result.childBytes[childKey] = (result.childBytes[childKey] ?? 0) + size
    }
  }

  walk(dir, 0, null)
  return result
}

function directoryBytes(dir: string): number {
  let total = 0
  const walk = (current: string): void => {
    let entries: ReturnType<typeof readdirSync>
    try {
      entries = readdirSync(current, { withFileTypes: true })
    }
    catch {
      return
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const full = join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else {
        try {
          total += statSync(full).size
        }
        catch { /* unreadable */ }
      }
    }
  }
  walk(dir)
  return total
}

function findHygiene(manifest: Manifest, scan: ScanResult): HygieneFinding[] {
  const findings: HygieneFinding[] = []

  for (const rule of HYGIENE_DIRS) {
    for (const name of rule.names) {
      if (!scan.topLevelDirs.includes(name)) continue
      findings.push({
        kind: rule.kind,
        detail: `${name}/ — ${rule.label}`,
        bytes: scan.childBytes[name] ?? 0,
      })
    }
  }

  for (const rule of HYGIENE_FILES) {
    for (const name of rule.names) {
      if (!scan.topLevelFiles.includes(name)) continue
      findings.push({ kind: rule.kind, detail: `${name} — ${rule.label}`, bytes: scan.childBytes[name] ?? 0 })
    }
  }

  // A missing `files` field is what lets everything above happen: without it
  // (and without .npmignore) npm packs the working tree minus a short
  // built-in list. Only worth reporting when something actually leaked.
  if (!manifest.files?.length && findings.length > 0) {
    findings.push({
      kind: 'no-files-field',
      detail: 'no "files" field — the tarball is the working tree',
      bytes: 0,
    })
  }

  return findings
}

/**
 * Every installed package directory under a `node_modules` tree.
 *
 * Symlinks are followed rather than skipped, because on pnpm almost everything
 * is one: `node_modules/foo` points into `node_modules/.pnpm/foo@1.2.3/...`,
 * where the bytes actually live. Skipping them reported a 285MB install as
 * 10MB of "real" directories — technically true and useless.
 *
 * A link is followed only when its target is inside the project. One that
 * leaves the project is a workspace package or a `bun link`: it lives in the
 * repository, not in the install, and charging the install for source the
 * developer already had would overstate every monorepo.
 *
 * Entries are keyed by real path, so the dozens of links pnpm makes to a single
 * store directory collapse into the one copy on disk.
 */
function collectPackageDirs(
  root: string,
  projectRoot: string,
  nesting: number,
  out: Array<{ dir: string, nesting: number }>,
  seen: Set<string>,
): void {
  const nodeModules = join(root, 'node_modules')
  let entries: ReturnType<typeof readdirSync>
  try {
    entries = readdirSync(nodeModules, { withFileTypes: true })
  }
  catch {
    return
  }

  const consider = (path: string, childNesting: number): void => {
    let real: string
    try {
      real = realpathSync(path)
    }
    catch {
      return
    }

    // Outside the project: a workspace package or a link, not an install.
    if (real !== projectRoot && !real.startsWith(`${projectRoot}/`))
      return
    if (!existsSync(join(real, 'package.json')))
      return
    if (seen.has(real))
      return

    seen.add(real)
    out.push({ dir: real, nesting: childNesting })
    collectPackageDirs(real, projectRoot, childNesting + 1, out, seen)
  }

  for (const entry of entries) {
    // `.pnpm` is the store every top-level link points into; its contents are
    // reached through those links, and it also holds packages nothing links to.
    if (entry.name === '.pnpm') {
      let stored: ReturnType<typeof readdirSync>
      try {
        stored = readdirSync(join(nodeModules, entry.name), { withFileTypes: true })
      }
      catch {
        continue
      }
      for (const dir of stored)
        collectPackageDirs(join(nodeModules, entry.name, dir.name), projectRoot, nesting, out, seen)
      continue
    }

    if (entry.name.startsWith('.'))
      continue

    const full = join(nodeModules, entry.name)

    if (entry.name.startsWith('@')) {
      let scoped: ReturnType<typeof readdirSync>
      try {
        scoped = readdirSync(full, { withFileTypes: true })
      }
      catch {
        continue
      }
      for (const inner of scoped)
        consider(join(full, inner.name), nesting)
      continue
    }

    consider(full, nesting)
  }
}

function readManifest(dir: string): Manifest | null {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')) as Manifest
  }
  catch {
    return null
  }
}

/**
 * Resolve a dependency name the way Node does: nearest `node_modules` first,
 * walking up towards the project root.
 */
function resolveFrom(fromDir: string, name: string, byPath: Map<string, PackageNode>, projectRoot: string): PackageNode | undefined {
  // Nodes are keyed by real path, so each candidate is resolved before lookup:
  // on pnpm every `node_modules/<name>` is a link into the store, and the raw
  // path matches nothing.
  const at = (dir: string): PackageNode | undefined => {
    const candidate = join(dir, 'node_modules', name)
    const direct = byPath.get(candidate)
    if (direct) return direct
    try {
      return byPath.get(realpathSync(candidate))
    }
    catch {
      return undefined
    }
  }

  let current = fromDir
  for (;;) {
    const node = at(current)
    if (node) return node
    if (current === projectRoot || current.length <= projectRoot.length) break
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return at(projectRoot)
}

export function analyzeNodeModules(projectRoot: string): NodeModulesAnalysis {
  const rootManifest = readManifest(projectRoot) ?? {}
  const dirs: Array<{ dir: string, nesting: number }> = []
  collectPackageDirs(projectRoot, projectRoot, 0, dirs, new Set<string>())

  const byPath = new Map<string, PackageNode>()
  const nodes: PackageNode[] = []

  for (const { dir, nesting } of dirs) {
    const manifest = readManifest(dir)
    if (!manifest) continue
    const scan = scanPackage(dir)
    const peerMeta = manifest.peerDependenciesMeta ?? {}
    const peerNames = Object.keys(manifest.peerDependencies ?? {})

    const node: PackageNode = {
      id: relative(projectRoot, dir),
      name: manifest.name ?? dir.split('node_modules/').pop() ?? dir,
      version: manifest.version ?? '0.0.0',
      path: relative(projectRoot, dir),
      nesting,
      description: manifest.description,
      license: manifest.license,
      homepage: manifest.homepage,
      deps: Object.keys(manifest.dependencies ?? {}),
      devDeps: Object.keys(manifest.devDependencies ?? {}),
      peerDeps: peerNames.filter(n => !peerMeta[n]?.optional),
      optionalPeerDeps: peerNames.filter(n => peerMeta[n]?.optional),
      hasBin: manifest.bin !== undefined,
      size: {
        self: scan.self,
        withNested: scan.withNested,
        files: scan.files,
        code: scan.code,
        types: scan.types,
        sourceMaps: scan.sourceMaps,
        docs: scan.docs,
        assets: scan.assets,
        other: scan.other,
      },
      hygiene: findHygiene(manifest, scan),
      dependents: [],
      depth: Number.POSITIVE_INFINITY,
      transitive: 0,
      exclusiveBytes: 0,
    }

    byPath.set(dir, node)
    nodes.push(node)
  }

  // Edges, resolved per install location rather than by name, so a nested copy
  // is charged to whoever nested it.
  const edges = new Map<string, PackageNode[]>()
  for (const node of nodes) {
    const dir = join(projectRoot, node.path)
    const resolved: PackageNode[] = []
    for (const name of [...node.deps, ...node.optionalPeerDeps]) {
      const target = resolveFrom(dir, name, byPath, projectRoot)
      if (!target || target === node) continue
      resolved.push(target)
      if (!target.dependents.includes(node.name)) target.dependents.push(node.name)
    }
    edges.set(node.id, resolved)
  }

  const rootDependencies = Object.keys(rootManifest.dependencies ?? {})
  const rootDevDependencies = Object.keys(rootManifest.devDependencies ?? {})
  const roots: PackageNode[] = []
  for (const name of [...rootDependencies, ...rootDevDependencies]) {
    const node = resolveFrom(projectRoot, name, byPath, projectRoot)
    if (node && !roots.includes(node)) roots.push(node)
  }

  // Depth by breadth-first walk from the root dependencies.
  const queue: PackageNode[] = []
  for (const node of roots) {
    node.depth = 0
    queue.push(node)
  }
  for (let i = 0; i < queue.length; i++) {
    const node = queue[i]
    for (const next of edges.get(node.id) ?? []) {
      if (next.depth <= node.depth + 1) continue
      next.depth = node.depth + 1
      queue.push(next)
    }
  }

  const reachFrom = (seeds: PackageNode[], excluded?: PackageNode): Set<PackageNode> => {
    const seen = new Set<PackageNode>()
    const stack = seeds.filter(n => n !== excluded)
    while (stack.length) {
      const node = stack.pop()!
      if (seen.has(node)) continue
      seen.add(node)
      for (const next of edges.get(node.id) ?? []) {
        if (next !== excluded && !seen.has(next)) stack.push(next)
      }
    }
    return seen
  }

  const reachable = reachFrom(roots)
  const bytesOf = (set: Iterable<PackageNode>): number => {
    let total = 0
    for (const node of set) total += node.size.self
    return total
  }
  const totalBytes = bytesOf(reachable)

  for (const node of nodes) {
    const own = reachFrom([node])
    own.delete(node)
    node.transitive = own.size

    if (!reachable.has(node)) {
      // Unreachable from any root: the whole thing is dead weight.
      node.exclusiveBytes = node.size.self
      continue
    }
    node.exclusiveBytes = totalBytes - bytesOf(reachFrom(roots, node))
  }

  // Duplicates: the same name installed more than once anywhere in the tree.
  const byName = new Map<string, PackageNode[]>()
  for (const node of nodes) {
    const list = byName.get(node.name)
    if (list) list.push(node)
    else byName.set(node.name, [node])
  }

  const duplicates: DuplicateGroup[] = []
  for (const [name, copies] of byName) {
    if (copies.length < 2) continue
    const sorted = [...copies].sort((a, b) => b.size.self - a.size.self)
    duplicates.push({
      name,
      copies: sorted.map(c => ({ version: c.version, path: c.path, bytes: c.size.self })),
      wastedBytes: sorted.slice(1).reduce((sum, c) => sum + c.size.self, 0),
    })
  }
  duplicates.sort((a, b) => b.wastedBytes - a.wastedBytes)

  const hygiene = nodes
    .filter(n => n.hygiene.length > 0)
    .map(n => ({
      name: n.name,
      version: n.version,
      path: n.path,
      findings: n.hygiene,
      bytes: n.hygiene.reduce((sum, f) => sum + f.bytes, 0),
    }))
    .sort((a, b) => b.bytes - a.bytes)

  const categoryTotals = { code: 0, types: 0, sourceMaps: 0, docs: 0, assets: 0, other: 0 }
  for (const node of reachable) {
    categoryTotals.code += node.size.code
    categoryTotals.types += node.size.types
    categoryTotals.sourceMaps += node.size.sourceMaps
    categoryTotals.docs += node.size.docs
    categoryTotals.assets += node.size.assets
    categoryTotals.other += node.size.other
  }

  const topByExclusive = [...nodes]
    .sort((a, b) => b.exclusiveBytes - a.exclusiveBytes)
    .slice(0, 40)
    .map(n => ({
      name: n.name,
      exclusiveBytes: n.exclusiveBytes,
      selfBytes: n.size.self,
      dependents: n.dependents.length,
    }))

  const topBySelf = [...nodes]
    .sort((a, b) => b.size.self - a.size.self)
    .slice(0, 40)
    .map(n => ({ name: n.name, bytes: n.size.self, path: n.path }))

  nodes.sort((a, b) => b.exclusiveBytes - a.exclusiveBytes || b.size.self - a.size.self)

  const depths = nodes.map(n => n.depth).filter(d => Number.isFinite(d))

  return {
    projectRoot,
    projectName: rootManifest.name ?? projectRoot.split('/').pop() ?? 'project',
    generatedAt: new Date().toISOString(),
    totalBytes,
    totalPackages: nodes.length,
    distinctNames: byName.size,
    maxDepth: depths.length ? Math.max(...depths) : 0,
    rootDependencies,
    rootDevDependencies,
    packages: nodes.map(n => ({ ...n, depth: Number.isFinite(n.depth) ? n.depth : -1 })),
    duplicates,
    hygiene,
    categoryTotals,
    topByExclusive,
    topBySelf,
  }
}
