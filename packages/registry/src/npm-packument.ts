/**
 * The npm registry protocol over packages published to Pantry.
 *
 * `GET /npm/{name}` answers with an npm packument (every version, `dist-tags`,
 * `dist.tarball` and `dist.integrity`), so a package manager that speaks npm's
 * protocol can install from Pantry by pointing a registry at it:
 *
 * ```toml
 * # bunfig.toml
 * [install.scopes]
 * "@stacksjs" = "https://registry.pantry.dev/npm/"
 * ```
 *
 * A name Pantry has no published versions of is redirected to npm, so
 * pointing a scope (or a whole install) here never loses a package that lives
 * only on npm, and never makes it wait on this server's own connection to npm.
 *
 * This is what lets a project publish its releases to Pantry alone: a
 * workspace release then uploads every package at once and each one is
 * installable the moment its upload returns, instead of waiting out npm's
 * propagation one dependency layer at a time.
 */
import type { PackageMetadata } from './types'

/** The slice of the metadata store a packument reads. */
export interface PackumentSource {
  listVersions: (name: string) => Promise<string[]>
  getPackageVersion: (name: string, version: string) => Promise<PackageMetadata | null>
}

/**
 * Manifest fields an installer reads from a packument version. Everything
 * else in the published manifest (scripts bodies, devDependencies, build
 * config) stays out of the document every install downloads.
 */
const INSTALL_FIELDS = [
  'description',
  'license',
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
  'peerDependenciesMeta',
  'bundleDependencies',
  'bin',
  'directories',
  'engines',
  'os',
  'cpu',
  'libc',
  'deprecated',
  'funding',
  'repository',
  'homepage',
  'author',
  'keywords',
] as const

const LIFECYCLE_INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall'] as const

/**
 * The stored checksum as npm's `dist` fields. Pantry stores `sha256:<hex>`
 * for what it receives, which npm clients take as SRI (`sha256-<base64>`).
 * A mirrored npm record carries `sha1:<hex>`, which is npm's `shasum`.
 */
export function npmDist(checksum: string | undefined): { integrity?: string, shasum?: string } {
  if (!checksum) return {}
  const [algorithm, hex] = checksum.split(':')
  if (!hex || !/^[0-9a-f]+$/i.test(hex)) return {}
  if (algorithm === 'sha1') return { shasum: hex.toLowerCase() }
  if (algorithm === 'sha256' || algorithm === 'sha384' || algorithm === 'sha512')
    return { integrity: `${algorithm}-${Buffer.from(hex, 'hex').toString('base64')}` }
  return {}
}

/** Order two versions by semver precedence (enough for picking `latest`). */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, pre] = v.split('+')[0]!.split(/-(.*)/s)
    return { parts: core!.split('.').map(n => Number.parseInt(n, 10) || 0), pre }
  }
  const left = parse(a)
  const right = parse(b)
  for (let i = 0; i < 3; i++) {
    const diff = (left.parts[i] ?? 0) - (right.parts[i] ?? 0)
    if (diff !== 0) return diff
  }
  if (left.pre === right.pre) return 0
  if (left.pre === undefined) return 1
  if (right.pre === undefined) return -1
  return left.pre.localeCompare(right.pre, undefined, { numeric: true })
}

/** The highest release, or the highest prerelease when there is no release. */
export function latestOf(versions: string[]): string | undefined {
  const sorted = [...versions].sort(compareVersions)
  const releases = sorted.filter(v => !v.split('+')[0]!.includes('-'))
  return (releases.length ? releases : sorted).at(-1)
}

/** One packument version from a stored Pantry version. */
export function packumentVersion(metadata: PackageMetadata, tarballUrl: string): Record<string, unknown> {
  const manifest = metadata as unknown as Record<string, unknown>
  const version: Record<string, unknown> = { name: metadata.name, version: metadata.version }
  for (const field of INSTALL_FIELDS) {
    if (manifest[field] !== undefined) version[field] = manifest[field]
  }
  const scripts = manifest.scripts
  if (scripts && typeof scripts === 'object' && LIFECYCLE_INSTALL_SCRIPTS.some(name => name in (scripts as object)))
    version.hasInstallScript = true
  version.dist = { tarball: tarballUrl, ...npmDist(metadata.checksum) }
  return version
}

/** The parts of an upstream (npm) packument a merge reads. */
export interface UpstreamPackument {
  'dist-tags'?: Record<string, string>
  'versions'?: Record<string, unknown>
  'time'?: Record<string, string>
}

/**
 * Pantry's packument with the versions only npm has added underneath.
 *
 * A project moving its releases to Pantry still has years of versions on npm,
 * and a scope pointed here must keep resolving them: without this, the first
 * Pantry publish of a name would hide every older version from installs that
 * pin one. Pantry's copy wins for a version both hold. `latest` is the newer
 * of the two `latest` tags, so whichever registry got the newest release
 * wins.
 */
export function mergeUpstream(
  packument: Record<string, unknown>,
  upstream: UpstreamPackument | null,
): Record<string, unknown> {
  if (!upstream?.versions) return packument
  const ours = packument.versions as Record<string, unknown>
  const versions = { ...upstream.versions, ...ours }
  const time = { ...upstream.time, ...(packument.time as Record<string, string>) }
  const tags = packument['dist-tags'] as Record<string, string>
  const theirs = upstream['dist-tags']?.latest
  const latest = theirs && versions[theirs] && compareVersions(theirs, tags.latest!) > 0 ? theirs : tags.latest!
  return {
    ...packument,
    'dist-tags': { ...upstream['dist-tags'], ...tags, latest },
    versions,
    'time': { ...time, modified: time[latest] ?? time.modified },
  }
}

/**
 * The npm packument for every version Pantry holds of `name`, or null when
 * it holds none (the caller then answers with npm's).
 */
export async function buildPackument(
  source: PackumentSource,
  name: string,
  baseUrl: string,
): Promise<Record<string, unknown> | null> {
  const listed = await source.listVersions(name)
  if (!listed.length) return null
  const stored = await Promise.all(listed.map(version => source.getPackageVersion(name, version)))
  const versions: Record<string, unknown> = {}
  const time: Record<string, string> = {}
  for (const metadata of stored) {
    if (!metadata) continue
    const tarball = `${baseUrl}/packages/${encodeURIComponent(name)}/${encodeURIComponent(metadata.version)}/tarball`
    versions[metadata.version] = packumentVersion(metadata, tarball)
    if (metadata.publishedAt) time[metadata.version] = metadata.publishedAt
  }
  const latest = latestOf(Object.keys(versions))
  if (!latest) return null
  const head = stored.find(metadata => metadata?.version === latest)!
  return {
    'name': name,
    'description': head.description,
    'dist-tags': { latest },
    'versions': versions,
    'time': { ...time, modified: time[latest] },
    'license': head.license,
    'homepage': head.homepage,
    'repository': head.repository,
  }
}

/**
 * The package (and, for `/npm/{name}/{version}`, the version or dist-tag) an
 * npm-protocol path names, or null. Clients send a scoped name as
 * `@scope%2fname` (npm, Bun) or `@scope/name`.
 */
export function npmRegistryPath(path: string): { name: string, version?: string } | null {
  const match = path.match(/^\/npm\/((?:@|%40)[^/%]+(?:%2[fF]|\/)[^/]+|[^/@%][^/]*)(?:\/([^/]+))?$/)
  if (!match) return null
  const name = decodeURIComponent(match[1]!)
  if (name.length > 214 || /[\s\\]/.test(name)) return null
  const version = match[2] === undefined ? undefined : decodeURIComponent(match[2])
  if (version !== undefined && !/^[\w.+-]{1,64}$/.test(version)) return null
  return version === undefined ? { name } : { name, version }
}

/**
 * One version of a packument by version or dist-tag (`latest`), the document
 * npm serves at `/{name}/{version}`.
 */
export function packumentVersionOrTag(packument: Record<string, unknown>, versionOrTag: string): unknown {
  const versions = packument.versions as Record<string, unknown>
  const tags = packument['dist-tags'] as Record<string, string> | undefined
  return versions[versionOrTag] ?? versions[tags?.[versionOrTag] ?? ''] ?? null
}

/**
 * npm's packument for a name Pantry also publishes, for `mergeUpstream`,
 * without letting npm's response time decide this endpoint's.
 *
 * Each read waits at most `timeoutMs` for npm. A copy younger than `ttlMs` is
 * served as is; an older one is served while a single refresh runs behind it;
 * with no copy yet, a slow or failed fetch yields null and the packument goes
 * out with Pantry's versions alone, which is every release published since the
 * project moved. Concurrent reads of one name share one fetch.
 */
export class UpstreamPackuments {
  private readonly copies = new Map<string, { doc: UpstreamPackument, at: number }>()
  private readonly inFlight = new Map<string, Promise<UpstreamPackument | null>>()

  constructor(
    private readonly fetchUpstream: (name: string) => Promise<UpstreamPackument | null>,
    private readonly ttlMs = 5 * 60_000,
    private readonly timeoutMs = 3_000,
    private readonly maxEntries = 1_000,
  ) {}

  async get(name: string, now = Date.now()): Promise<UpstreamPackument | null> {
    const copy = this.copies.get(name)
    if (copy && now - copy.at < this.ttlMs) return copy.doc
    const refresh = this.refresh(name)
    if (copy) return copy.doc
    const timeout = new Promise<null>(resolve => setTimeout(resolve, this.timeoutMs, null))
    return Promise.race([refresh, timeout])
  }

  private refresh(name: string): Promise<UpstreamPackument | null> {
    const running = this.inFlight.get(name)
    if (running) return running
    const fetching = this.fetchUpstream(name)
      .catch(() => null)
      .then((doc) => {
        if (doc?.versions) {
          if (this.copies.size >= this.maxEntries && !this.copies.has(name))
            this.copies.delete(this.copies.keys().next().value!)
          this.copies.set(name, { doc, at: Date.now() })
        }
        return doc?.versions ? doc : this.copies.get(name)?.doc ?? null
      })
      .finally(() => this.inFlight.delete(name))
    this.inFlight.set(name, fetching)
    return fetching
  }
}

/** Where npm serves `name` (and a version or tag of it), for a redirect. */
export function npmRegistryUrl(name: string, version?: string): string {
  const path = name.startsWith('@') ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name)
  return `https://registry.npmjs.org/${path}${version === undefined ? '' : `/${encodeURIComponent(version)}`}`
}
