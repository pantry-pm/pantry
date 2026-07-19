/**
 * Workspace protocol rewriting for published package manifests.
 *
 * A literal `workspace:` range must never reach a registry — npm and bun
 * cannot install it, so a package published with one is uninstallable.
 * Pack/publish paths (`pantry publish`, `pantry publish:commit`, and the
 * pack helper in `app/`) rewrite those ranges in the manifest that gets
 * packed, exactly like `bun publish` does:
 *
 *   "workspace:*" / bare "workspace:" -> exact version   ("0.1.0")
 *   "workspace:^"                     -> caret range     ("^0.1.0")
 *   "workspace:~"                     -> tilde range     ("~0.1.0")
 *   "workspace:<range>"               -> range kept, prefix stripped
 *                                        ("workspace:^1.0.0" -> "^1.0.0")
 *
 * Ranges are rewritten across `dependencies`, `devDependencies`,
 * `peerDependencies`, and `optionalDependencies` (bun/npm keep
 * devDependencies in the published manifest, so workspace refs there must
 * be rewritten too).
 *
 * Versions resolve from the workspace's own packages: the workspace root
 * is located by walking up from the published package until a package.json
 * with a `workspaces` field is found, and member packages are discovered
 * by expanding those globs. When a referenced workspace package — or its
 * version — cannot be resolved, rewriting fails loudly by throwing
 * {@link UnresolvableWorkspaceDependencyError} naming the dependency.
 *
 * The repo's on-disk package.json is never mutated: callers rewrite the
 * in-memory/staged manifest that goes into the tarball.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { Glob } from 'bun'

/** Dependency sections that may carry workspace: ranges in a published manifest. */
export const WORKSPACE_RANGE_SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const

export type DependencySection = typeof WORKSPACE_RANGE_SECTIONS[number]

/** A workspace member package discovered from the workspace root's globs. */
export interface WorkspacePackage {
  name: string
  version?: string
  dir: string
}

/** A single workspace: range replacement that was applied. */
export interface WorkspaceRangeResolution {
  name: string
  section: DependencySection
  from: string
  to: string
}

/** Result of rewriting a manifest: the publishable manifest plus what changed. */
export interface RewriteResult {
  /** A copy of the input when anything was rewritten, otherwise the original reference. */
  manifest: Record<string, any>
  resolutions: WorkspaceRangeResolution[]
}

/** Error thrown when a workspace: range cannot be resolved from the workspace's own packages. */
export class UnresolvableWorkspaceDependencyError extends Error {
  readonly dependency: string
  readonly section: string

  constructor(message: string, dependency: string, section: string) {
    super(message)
    this.name = 'UnresolvableWorkspaceDependencyError'
    this.dependency = dependency
    this.section = section
  }
}

export class UnresolvableCatalogDependencyError extends Error {
  readonly dependency: string
  readonly section: string

  constructor(message: string, dependency: string, section: string) {
    super(message)
    this.name = 'UnresolvableCatalogDependencyError'
    this.dependency = dependency
    this.section = section
  }
}

/** Compute the published range for a `workspace:` spec given the resolved version. */
export function resolveWorkspaceSpec(spec: string, version: string): string {
  // "workspace:*" and bare "workspace:" pin the exact current version.
  if (spec === '' || spec === '*') return version
  if (spec === '^') return `^${version}`
  if (spec === '~') return `~${version}`
  // "workspace:<range>" keeps the range verbatim, dropping the protocol prefix.
  return spec
}

/** Extract workspace globs from a parsed root package.json — array form or `{ packages: [...] }`. */
export function readWorkspaceGlobsFromManifest(manifest: unknown): string[] {
  if (!manifest || typeof manifest !== 'object') return []
  const workspaces = (manifest as Record<string, unknown>).workspaces
  if (Array.isArray(workspaces)) return workspaces.filter((p): p is string => typeof p === 'string')
  if (workspaces && typeof workspaces === 'object') {
    const packages = (workspaces as Record<string, unknown>).packages
    if (Array.isArray(packages)) return packages.filter((p): p is string => typeof p === 'string')
  }
  return []
}

/** Read the workspace globs declared by the package.json in `rootDir`. */
export function readWorkspaceGlobs(rootDir: string): string[] {
  const manifestPath = join(rootDir, 'package.json')
  if (!existsSync(manifestPath)) return []
  try {
    return readWorkspaceGlobsFromManifest(JSON.parse(readFileSync(manifestPath, 'utf-8')))
  }
  catch {
    return []
  }
}

/**
 * Locate the workspace root for `startDir`: the nearest directory at or
 * above it whose package.json declares a non-empty `workspaces` field.
 * Returns null when no ancestor declares workspaces.
 */
export function findWorkspaceRoot(startDir: string): string | null {
  let current = resolve(startDir)
  for (let depth = 0; depth < 32; depth++) {
    const manifestPath = join(current, 'package.json')
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))
        if (readWorkspaceGlobsFromManifest(manifest).length > 0) {
          return current
        }
      }
      catch {
        // Unreadable manifest — keep walking up.
      }
    }
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
  return null
}

/**
 * Discover the workspace's own packages by expanding the root package.json
 * `workspaces` globs. Returns a map of package name to manifest info.
 */
export function resolveWorkspacePackages(rootDir: string, globs: string[] = readWorkspaceGlobs(rootDir)): Map<string, WorkspacePackage> {
  const packages = new Map<string, WorkspacePackage>()
  for (const pattern of globs) {
    // Workspace patterns are directory globs; `onlyFiles: false` yields the
    // matching directories themselves (plus files, which the package.json
    // check below filters out).
    let matches: string[]
    try {
      matches = [...new Glob(pattern).scanSync({ cwd: rootDir, onlyFiles: false })]
    }
    catch {
      continue
    }
    for (const match of matches) {
      const dir = join(rootDir, match)
      const manifestPath = join(dir, 'package.json')
      if (!existsSync(manifestPath)) continue
      let manifest: Record<string, unknown>
      try {
        manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))
      }
      catch {
        continue
      }
      if (typeof manifest.name !== 'string' || manifest.name.length === 0) continue
      // First match wins — a name shadowed by an earlier glob stays stable.
      if (packages.has(manifest.name)) continue
      packages.set(manifest.name, {
        name: manifest.name,
        version: typeof manifest.version === 'string' ? manifest.version : undefined,
        dir,
      })
    }
  }
  return packages
}

function firstWorkspaceRange(manifest: Record<string, any>): { name: string, section: DependencySection, range: string } | null {
  for (const section of WORKSPACE_RANGE_SECTIONS) {
    const deps = manifest[section]
    if (!deps || typeof deps !== 'object' || Array.isArray(deps)) continue
    for (const [name, range] of Object.entries(deps)) {
      if (typeof range === 'string' && range.startsWith('workspace:')) {
        return { name, section, range }
      }
    }
  }
  return null
}

/** True when any dependency section of the manifest carries a workspace: range. */
export function manifestUsesWorkspaceProtocol(manifest: Record<string, any>): boolean {
  return firstWorkspaceRange(manifest) !== null
}

function firstCatalogRange(manifest: Record<string, any>): { name: string, section: DependencySection, range: string } | null {
  for (const section of WORKSPACE_RANGE_SECTIONS) {
    const deps = manifest[section]
    if (!deps || typeof deps !== 'object' || Array.isArray(deps)) continue
    for (const [name, range] of Object.entries(deps)) {
      if (typeof range === 'string' && range.startsWith('catalog:'))
        return { name, section, range }
    }
  }
  return null
}

export function manifestUsesCatalogProtocol(manifest: Record<string, any>): boolean {
  return firstCatalogRange(manifest) !== null
}

function catalogMap(root: Record<string, any>, name: string): Record<string, string> | undefined {
  const source = root[name ? 'catalogs' : 'catalog'] ?? (root.workspaces && !Array.isArray(root.workspaces) ? root.workspaces[name ? 'catalogs' : 'catalog'] : undefined)
  const catalog = name ? source?.[name] : source
  return catalog && typeof catalog === 'object' && !Array.isArray(catalog) ? catalog : undefined
}

export function rewriteCatalogRanges(manifest: Record<string, any>, root: Record<string, any>): RewriteResult {
  const resolutions: WorkspaceRangeResolution[] = []
  let result = manifest
  for (const section of WORKSPACE_RANGE_SECTIONS) {
    const deps = manifest[section]
    if (!deps || typeof deps !== 'object' || Array.isArray(deps)) continue
    for (const [dep, range] of Object.entries(deps)) {
      if (typeof range !== 'string' || !range.startsWith('catalog:')) continue
      const name = range.slice('catalog:'.length)
      const version = catalogMap(root, name)?.[dep]
      if (typeof version !== 'string' || !version) {
        throw new UnresolvableCatalogDependencyError(
          `Cannot publish "${String(manifest.name ?? 'package')}" - dependency "${dep}" (${section}) uses "${range}" but the workspace root does not define it in that catalog.`,
          dep,
          section,
        )
      }
      if (result === manifest) result = { ...manifest }
      if (result[section] === deps) result[section] = { ...deps }
      result[section][dep] = version
      resolutions.push({ name: dep, section, from: range, to: version })
    }
  }
  return { manifest: result, resolutions }
}

/**
 * Rewrite workspace: ranges in a parsed package.json manifest against an
 * already-resolved package map. Never mutates the input — returns a copy
 * when (and only when) a range is rewritten.
 */
export function rewriteWorkspaceRanges(
  manifest: Record<string, any>,
  packages: Map<string, WorkspacePackage>,
  options: { packageName?: string, workspaceRoot?: string } = {},
): RewriteResult {
  const resolutions: WorkspaceRangeResolution[] = []
  let result = manifest

  const owner = options.packageName ? `"${options.packageName}" ` : ''
  const lookedIn = options.workspaceRoot ? ` (workspace root: ${options.workspaceRoot})` : ''

  for (const section of WORKSPACE_RANGE_SECTIONS) {
    const deps = manifest[section]
    if (!deps || typeof deps !== 'object' || Array.isArray(deps)) continue

    for (const [dep, range] of Object.entries(deps)) {
      if (typeof range !== 'string' || !range.startsWith('workspace:')) continue
      const spec = range.slice('workspace:'.length)
      const pkg = packages.get(dep)
      if (!pkg) {
        throw new UnresolvableWorkspaceDependencyError(
          `Cannot publish ${owner}— dependency "${dep}" (${section}) uses "${range}" but no workspace package named "${dep}" exists${lookedIn}. Refusing to publish an unresolvable workspace: range.`,
          dep,
          section,
        )
      }
      if (!pkg.version) {
        throw new UnresolvableWorkspaceDependencyError(
          `Cannot publish ${owner}— workspace package "${dep}" (${section}, at ${pkg.dir}) has no "version" field. Refusing to publish an unresolvable "${range}" range.`,
          dep,
          section,
        )
      }
      const to = resolveWorkspaceSpec(spec, pkg.version)
      // Clone lazily: copy the manifest and each section only when first touched.
      if (result === manifest) result = { ...manifest }
      if (result[section] === deps) result[section] = { ...deps }
      result[section][dep] = to
      resolutions.push({ name: dep, section, from: range, to })
    }
  }

  return { manifest: result, resolutions }
}

/**
 * Rewrite workspace: ranges in a parsed manifest, resolving versions from
 * the workspace containing `packageDir`. Manifests without workspace: refs
 * are returned untouched; refs without a discoverable workspace root fail
 * loudly like any other unresolvable range.
 */
export function rewriteManifestForPublish(
  manifest: Record<string, any>,
  packageDir: string,
): RewriteResult {
  const usesWorkspace = manifestUsesWorkspaceProtocol(manifest)
  const usesCatalog = manifestUsesCatalogProtocol(manifest)
  if (!usesWorkspace && !usesCatalog) return { manifest, resolutions: [] }

  const packageName = typeof manifest.name === 'string' ? manifest.name : undefined
  const root = findWorkspaceRoot(packageDir)
  if (!root) {
    const ref = firstWorkspaceRange(manifest)!
    throw new UnresolvableWorkspaceDependencyError(
      `Cannot publish ${packageName ? `"${packageName}" ` : ''}— dependency "${ref.name}" (${ref.section}) uses "${ref.range}" but no workspace root (a package.json with "workspaces") was found at or above ${packageDir}. Refusing to publish an unresolvable workspace: range.`,
      ref.name,
      ref.section,
    )
  }

  const workspaceResult = usesWorkspace
    ? rewriteWorkspaceRanges(manifest, resolveWorkspacePackages(root), { packageName, workspaceRoot: root })
    : { manifest, resolutions: [] }
  if (!usesCatalog) return workspaceResult

  const rootManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'))
  const catalogResult = rewriteCatalogRanges(workspaceResult.manifest, rootManifest)
  return { manifest: catalogResult.manifest, resolutions: [...workspaceResult.resolutions, ...catalogResult.resolutions] }
}

/**
 * Rewrite the workspace: ranges in raw package.json `content` read from
 * `packageDir`. When a rewrite is applied the manifest is re-serialized
 * with two-space indentation; otherwise the original content is returned
 * byte-for-byte. The on-disk package.json is never modified — callers write
 * the returned content to their staged/packed copy only.
 */
export function rewritePackageJsonContent(content: string, packageDir: string): { content: string, rewritten: boolean, resolutions: WorkspaceRangeResolution[] } {
  const manifest = JSON.parse(content)
  const result = rewriteManifestForPublish(manifest, packageDir)
  if (result.resolutions.length === 0) {
    return { content, rewritten: false, resolutions: [] }
  }
  return { content: `${JSON.stringify(result.manifest, null, 2)}\n`, rewritten: true, resolutions: result.resolutions }
}
