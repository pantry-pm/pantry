/**
 * Cross-platform system package installer for pantry.
 *
 * Uses Node.js APIs exclusively — works on macOS, Linux, and Windows
 * without requiring the Zig CLI binary. This is the canonical way to
 * install system packages (zig, bun, node, etc.) from pantry recipes.
 *
 * Usage:
 *   import { installPackage, detectPlatform } from 'ts-pantry/installer'
 *   await installPackage('ziglang.org', '0.16.0-dev.2984+cb7d2b056', { installDir: './pantry' })
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import * as https from 'node:https'
import * as http from 'node:http'
import { execFileSync } from 'node:child_process'
import { compareVersions } from './generate-zig'

const PANTRY_REGISTRY = (process.env.PANTRY_REGISTRY_URL || 'https://registry.pantry.dev').replace(/\/$/, '')

// ── Types ──

export interface Platform {
  os: 'darwin' | 'linux' | 'windows'
  arch: 'x86_64' | 'aarch64'
}

export interface InstallOptions {
  /** Directory to install into (default: ./pantry) */
  installDir?: string
  /** Override the detected host platform, e.g. when fetching a Linux deploy binary from macOS. */
  platform?: Platform
  /** Create .bin/ symlinks/copies (default: true) */
  createBinLinks?: boolean
  /** Quiet mode — suppress progress output (default: false) */
  quiet?: boolean
  /**
   * Mirror this package's binaries to a stable user-level directory so they
   * appear on PATH after a one-time `pantry shell-init`. When `true` the
   * default global bin dir (`globalBinDir()`) is used; pass a path to override.
   *
   * This is what makes `pantry install <foo>@<v>` actually put `foo` on the
   * caller's PATH the same way Homebrew does.
   */
  globalBin?: boolean | string
}

export interface InstallResult {
  name: string
  version: string
  installPath: string
  binaries: string[]
  /** Symlinks created in the global bin dir, if `globalBin` was requested. */
  globalLinks?: string[]
}

/**
 * Stable user-level directory we expose on PATH via `pantry shell-init`.
 * Mirrors the Zig CLI's `$HOME/.local/share/pantry/global/bin` convention so
 * both installers can share a single location.
 */
export function globalBinDir(): string {
  // Honour XDG_DATA_HOME first to be friendly to Linux/Nix-style users.
  const xdg = process.env.XDG_DATA_HOME
  const base = xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), '.local', 'share')
  return path.join(base, 'pantry', 'global', 'bin')
}

/**
 * Registry of known system packages and how to install them.
 * Each entry maps a package domain to a function that returns the download URL
 * and list of binaries for a given version and platform.
 */
interface PackageResolver {
  /** Build the download URL for this package+version+platform */
  getDownloadUrl(version: string, platform: Platform): string
  /** Archive format */
  getArchiveFormat(platform: Platform): 'tar.xz' | 'tar.gz' | 'zip'
  /** List of binaries this package provides */
  getBinaries(platform: Platform): string[]
  /** The directory name inside the archive (if any) */
  getArchivePrefix?(version: string, platform: Platform): string
}

// ── Platform Detection ──

export function detectPlatform(): Platform {
  const osName = os.platform()
  const arch = os.arch()

  return {
    os: osName === 'darwin' ? 'darwin' : osName === 'win32' ? 'windows' : 'linux',
    arch: arch === 'arm64' ? 'aarch64' : 'x86_64',
  }
}

// ── Package Resolvers ──

const resolvers: Record<string, PackageResolver> = {
  'github.com/mail-os/mail': {
    getDownloadUrl(version: string, platform: Platform): string {
      if (platform.os !== 'linux' || platform.arch !== 'x86_64') {
        throw new Error('github.com/mail-os/mail currently publishes linux-x86_64 release binaries')
      }
      const osMap: Record<string, string> = { darwin: 'macos', linux: 'linux', windows: 'windows' }
      const artifact = `mail-${platform.arch}-${osMap[platform.os]}`
      return `https://github.com/mail-os/mail/releases/download/v${version}/${artifact}.tar.gz`
    },
    getArchiveFormat() {
      return 'tar.gz' as const
    },
    getBinaries(platform: Platform) {
      const osMap: Record<string, string> = { darwin: 'macos', linux: 'linux', windows: 'windows' }
      return [`mail-${platform.arch}-${osMap[platform.os]}`, 'mail']
    },
  },

  'ziglang.org': {
    getDownloadUrl(version: string, platform: Platform): string {
      const platformKey = `${platform.os}-${platform.arch === 'aarch64' ? 'arm64' : 'x86-64'}`
      const archive = `ziglang.org-${version}.${platform.os === 'windows' ? 'zip' : 'tar.gz'}`
      return `${PANTRY_REGISTRY}/binaries/ziglang.org/${version}/${platformKey}/${archive}`
    },
    getArchiveFormat(platform: Platform) {
      return platform.os === 'windows' ? 'zip' : 'tar.gz'
    },
    getBinaries(platform: Platform) {
      return platform.os === 'windows' ? ['zig.exe'] : ['zig']
    },
  },

  'bun.sh': {
    getDownloadUrl(version: string, platform: Platform): string {
      const platformMap: Record<string, string> = {
        'darwin-aarch64': 'darwin-aarch64',
        'darwin-x86_64': 'darwin-x64',
        'linux-aarch64': 'linux-aarch64',
        'linux-x86_64': 'linux-x64',
        'windows-x86_64': 'windows-x64',
      }
      const key = `${platform.os}-${platform.arch}`
      const platStr = platformMap[key] || 'linux-x64'
      return `https://github.com/oven-sh/bun/releases/download/bun-v${version}/bun-${platStr}.zip`
    },
    getArchiveFormat() {
      return 'zip' as const
    },
    getBinaries(platform: Platform) {
      return platform.os === 'windows' ? ['bun.exe'] : ['bun', 'bunx']
    },
    getArchivePrefix(_version: string, platform: Platform) {
      const platformMap: Record<string, string> = {
        'darwin-aarch64': 'bun-darwin-aarch64',
        'darwin-x86_64': 'bun-darwin-x64',
        'linux-aarch64': 'bun-linux-aarch64',
        'linux-x86_64': 'bun-linux-x64',
        'windows-x86_64': 'bun-windows-x64',
      }
      const key = `${platform.os}-${platform.arch}`
      const prefix = platformMap[key]
      if (!prefix) throw new Error(`Unsupported platform for bun: ${key}`)
      return prefix
    },
  },

  'nodejs.org': {
    getDownloadUrl(version: string, platform: Platform): string {
      const osMap: Record<string, string> = { darwin: 'darwin', linux: 'linux', windows: 'win' }
      const archMap: Record<string, string> = { x86_64: 'x64', aarch64: 'arm64' }
      const ext = platform.os === 'windows' ? 'zip' : 'tar.xz'
      return `https://nodejs.org/dist/v${version}/node-v${version}-${osMap[platform.os]}-${archMap[platform.arch]}.${ext}`
    },
    getArchiveFormat(platform: Platform) {
      return platform.os === 'windows' ? 'zip' : 'tar.xz'
    },
    getBinaries(platform: Platform) {
      return platform.os === 'windows' ? ['node.exe', 'npm.cmd', 'npx.cmd'] : ['node', 'npm', 'npx']
    },
    getArchivePrefix(version: string, platform: Platform) {
      const osMap: Record<string, string> = { darwin: 'darwin', linux: 'linux', windows: 'win' }
      const archMap: Record<string, string> = { x86_64: 'x64', aarch64: 'arm64' }
      return `node-v${version}-${osMap[platform.os]}-${archMap[platform.arch]}`
    },
  },
}

// ── Core Install Function ──

/**
 * (Re)create the `.bin/<name>` links for an installed package, pointing each at
 * the real binary under `pkgDir` (root or `bin/` subdir). Binaries absent from
 * the archive (e.g. `bunx`, `npx`) are aliased to the primary binary.
 *
 * This is intentionally idempotent and always run — including for already-installed
 * packages — so a real binary reliably *owns* its `.bin` entry. Without this, a
 * second installer writing the same dir (e.g. a registry client that drops a
 * placeholder stub for a platform it lacks) could leave `.bin/<name>` pointing at
 * a broken stub even though the genuine binary is present on disk.
 */
function linkBinaries(pkgDir: string, binaries: string[], binDir: string, platform: Platform): void {
  fs.mkdirSync(binDir, { recursive: true })
  let primaryBin: string | null = null

  for (const bin of binaries) {
    // Check both root and bin/ subdirectory
    let srcBin = path.join(pkgDir, bin)
    if (!fs.existsSync(srcBin)) {
      srcBin = path.join(pkgDir, 'bin', bin)
    }

    if (!fs.existsSync(srcBin)) {
      // Binary doesn't exist in archive — create as alias to primary binary
      // (e.g. bunx -> bun, npx -> node)
      if (primaryBin) {
        const dstBin = path.join(binDir, bin)
        try { fs.unlinkSync(dstBin) } catch { /* */ }
        if (platform.os === 'windows') {
          fs.copyFileSync(primaryBin, dstBin)
        }
        else {
          fs.symlinkSync(primaryBin, dstBin)
        }
      }
      continue
    }

    if (!primaryBin) primaryBin = srcBin

    const dstBin = path.join(binDir, bin)
    try { fs.unlinkSync(dstBin) } catch { /* doesn't exist */ }

    if (platform.os === 'windows') {
      fs.copyFileSync(srcBin, dstBin)
    }
    else {
      fs.symlinkSync(srcBin, dstBin)
    }
  }
}

/**
 * Install a system package by downloading from its official source.
 * Works cross-platform using only Node.js APIs.
 */
export async function installPackage(
  domain: string,
  version: string,
  options: InstallOptions = {},
): Promise<InstallResult> {
  const platform = options.platform || detectPlatform()
  const resolver = resolvers[domain]
  if (!resolver) {
    throw new Error(`Unknown package: ${domain}. Supported: ${Object.keys(resolvers).join(', ')}`)
  }

  // Resolve semver constraints (^, ~, >=, etc.) to concrete versions
  if (/^[\^~>=<]/.test(version)) {
    version = await resolveVersionConstraint(domain, version)
  }
  else if (version === 'latest' || version === '*' || !version) {
    version = await resolveLatestVersion(domain)
  }
  // Resolve short dev versions (e.g. "0.16.0-dev") to full version via upstream API
  else if (domain === 'ziglang.org' && version.endsWith('-dev')) {
    const resolved = await resolveZigShortDevVersion(version)
    if (resolved) version = resolved
  }

  // Catch every path where version resolution silently produced "". An
  // empty version string used to slip through and become a `bun-v/...`-
  // style 404 a few seconds later — a 5-step debug for what's really a
  // resolver failure.
  if (!version) {
    throw new Error(`Could not resolve a concrete version for ${domain} (got empty string from resolver)`)
  }

  const installDir = options.installDir || path.join(process.cwd(), 'pantry')
  const binDir = path.join(installDir, '.bin')
  const pkgDir = path.join(installDir, domain.replace(/\./g, '-'), version)

  // Check if already installed
  const binaries = resolver.getBinaries(platform)
  if (binaries.length === 0) {
    throw new Error(`No binaries defined for ${domain} on ${platform.os}-${platform.arch}`)
  }
  const firstBin = path.join(pkgDir, binaries[0])
  const firstBinInSubdir = path.join(pkgDir, 'bin', binaries[0])
  if (fs.existsSync(firstBin) || fs.existsSync(firstBinInSubdir)) {
    if (!options.quiet) console.log(`  ✓ ${domain}@${version} (cached)`)
    // Re-assert the .bin links even when already installed, so the genuine
    // binary keeps ownership of `.bin/<name>` if another installer clobbered it.
    if (options.createBinLinks !== false) {
      linkBinaries(pkgDir, binaries, binDir, platform)
    }
    const globalLinks = maybeLinkToGlobalBin(pkgDir, binaries, platform, options)
    return { name: domain, version, installPath: pkgDir, binaries, globalLinks }
  }

  const url = resolver.getDownloadUrl(version, platform)
  const format = resolver.getArchiveFormat(platform)

  if (!options.quiet) console.log(`  → ${domain}@${version} from ${new URL(url).hostname}`)

  // Download
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pantry-'))
  const archivePath = path.join(tmpDir, `archive.${format}`)

  try {
    await downloadFile(url, archivePath, 10, options.quiet ?? false)

    // Extract
    const extractDir = path.join(tmpDir, 'extracted')
    fs.mkdirSync(extractDir, { recursive: true })
    await extractArchive(archivePath, extractDir, format)

    // Find the source directory (archives usually have a top-level folder)
    let sourceDir = extractDir
    const prefix = resolver.getArchivePrefix?.(version, platform)
    if (prefix) {
      const prefixPath = path.join(extractDir, prefix)
      if (fs.existsSync(prefixPath)) {
        sourceDir = prefixPath
      }
      else {
        // Try first directory in extract
        const entries = fs.readdirSync(extractDir)
        const firstDir = entries.find(e => fs.statSync(path.join(extractDir, e)).isDirectory())
        if (firstDir) sourceDir = path.join(extractDir, firstDir)
      }
    }

    // Copy to install directory
    fs.mkdirSync(pkgDir, { recursive: true })
    copyDirRecursive(sourceDir, pkgDir)

    // Make binaries executable (non-Windows)
    if (platform.os !== 'windows') {
      for (const bin of binaries) {
        const binPath = path.join(pkgDir, bin)
        if (fs.existsSync(binPath)) {
          fs.chmodSync(binPath, 0o755)
        }
        // Also check bin/ subdirectory
        const binSubPath = path.join(pkgDir, 'bin', bin)
        if (fs.existsSync(binSubPath)) {
          fs.chmodSync(binSubPath, 0o755)
        }
      }
    }

    // Create .bin/ links
    if (options.createBinLinks !== false) {
      linkBinaries(pkgDir, binaries, binDir, platform)
    }

    if (!options.quiet) console.log(`  ✓ ${domain}@${version}`)
    const globalLinks = maybeLinkToGlobalBin(pkgDir, binaries, platform, options)
    return { name: domain, version, installPath: pkgDir, binaries, globalLinks }
  }
  finally {
    // Clean up temp directory
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* */ }
  }
}

/**
 * If `options.globalBin` is set, mirror each freshly installed binary into the
 * stable global bin dir so users can put a single dir on PATH and have every
 * pantry-installed package show up there. Returns the list of created link
 * paths (or an empty array when the option is off).
 */
function maybeLinkToGlobalBin(
  pkgDir: string,
  binaries: string[],
  platform: Platform,
  options: InstallOptions,
): string[] {
  if (!options.globalBin) return []

  const targetDir = typeof options.globalBin === 'string' ? options.globalBin : globalBinDir()
  fs.mkdirSync(targetDir, { recursive: true })

  const created: string[] = []
  for (const bin of binaries) {
    let srcBin = path.join(pkgDir, bin)
    if (!fs.existsSync(srcBin)) srcBin = path.join(pkgDir, 'bin', bin)
    if (!fs.existsSync(srcBin)) continue

    const dstBin = path.join(targetDir, bin)
    try { fs.unlinkSync(dstBin) }
    catch { /* missing is fine */ }

    if (platform.os === 'windows') {
      fs.copyFileSync(srcBin, dstBin)
    }
    else {
      fs.symlinkSync(srcBin, dstBin)
    }
    created.push(dstBin)
  }

  if (!options.quiet && created.length > 0) {
    console.log(`    → linked ${created.length} binary(ies) into ${targetDir}`)
  }
  return created
}

/**
 * Install multiple packages in parallel.
 */
export async function installPackages(
  packages: Array<{ domain: string, version: string }>,
  options: InstallOptions = {},
): Promise<InstallResult[]> {
  return Promise.all(
    packages.map(pkg => installPackage(pkg.domain, pkg.version, options)),
  )
}

/**
 * Resolve 'latest' version for known packages.
 */
export async function resolveLatestVersion(domain: string): Promise<string> {
  if (domain === 'bun.sh') {
    // Try GitHub API first, then fall back to the newest version in the
    // bundled package metadata. The earlier code returned `""` on API
    // failure, which produced a `bun-v/bun-linux-x64.zip` 404 — silently
    // breaking CI installs for anyone whose runner pool was rate-limited
    // (60 req/hr unauthenticated, easy to exhaust).
    const resp = await fetchJSON('https://api.github.com/repos/oven-sh/bun/releases/latest').catch(() => null)
    const tag = (resp as { tag_name?: string } | null)?.tag_name?.replace(/^bun-v/, '') || ''
    if (tag) return tag
    const fallback = await latestFromPackageMetadata(domain)
    if (fallback) return fallback
    throw new Error('Failed to resolve latest bun.sh version (GitHub API unreachable, no bundled metadata)')
  }
  if (domain === 'ziglang.org') {
    const versions = await registryVersions(domain)
    if (versions.length > 0) return versions.sort(compareVersions)[0]
    const fallback = await latestFromPackageMetadata(domain)
    if (fallback) return fallback
    throw new Error('Failed to resolve latest ziglang.org version from the Pantry registry')
  }
  if (domain === 'nodejs.org') {
    const resp = await fetchJSON('https://nodejs.org/dist/index.json').catch(() => null)
    const versions = (resp as Array<{ version: string, lts: boolean | string }> | null) || []
    const lts = versions.find(v => v.lts)
    const v = (lts?.version || versions[0]?.version || '').replace(/^v/, '')
    if (v) return v
    const fallback = await latestFromPackageMetadata(domain)
    if (fallback) return fallback
    throw new Error('Failed to resolve latest nodejs.org version')
  }
  if (domain === 'github.com/mail-os/mail') {
    const resp = await fetchJSON('https://api.github.com/repos/mail-os/mail/releases/latest').catch(() => null)
    const releaseTag = (resp as { tag_name?: string } | null)?.tag_name?.replace(/^v/, '') || ''
    if (releaseTag) return releaseTag

    const tags = await fetchJSON('https://api.github.com/repos/mail-os/mail/tags?per_page=1').catch(() => null)
    const tag = ((tags as Array<{ name?: string }> | null)?.[0]?.name || '').replace(/^v/, '')
    if (tag) return tag

    const fallback = await latestFromPackageMetadata(domain)
    if (fallback) return fallback
    throw new Error('Failed to resolve latest github.com/mail-os/mail version')
  }
  throw new Error(`Cannot resolve latest version for ${domain}`)
}

/** Return the highest version from `packages/index.js` for `domain`, or "". */
async function latestFromPackageMetadata(domain: string): Promise<string> {
  try {
    const pkgKey = domain.replace(/[^a-z0-9]/gi, '').toLowerCase()
    const { packages } = await import('./packages/index.js').catch(() => import('./index.js'))
    // The generated `Pantry` type is a closed object; the cast through
    // `unknown` lets us look up by computed key without listing every
    // domain explicitly here.
    const pkg = (packages as unknown as Record<string, { versions?: readonly string[] }>)[pkgKey]
    const versions = pkg?.versions || []
    // Take the first stable (non-pre-release) version — the bundled list is
    // typically newest-first; fall back to any version if there are no stables.
    return versions.find(v => !v.includes('-')) || versions[0] || ''
  }
  catch {
    return ''
  }
}

/**
 * Resolve a short Zig dev version like "0.17.0-dev" from the Pantry registry.
 */
async function resolveZigShortDevVersion(shortVersion: string): Promise<string | null> {
  const versions = await registryVersions('ziglang.org')
  return versions.filter(version => version.startsWith(`${shortVersion}.`)).sort(compareVersions)[0] || null
}

async function registryVersions(domain: string): Promise<string[]> {
  const metadata = await fetchJSON(`${PANTRY_REGISTRY}/binaries/${encodeURI(domain)}/metadata.json`)
    .catch(() => null) as { versions?: Record<string, unknown> } | null
  return Object.keys(metadata?.versions || {})
}

/** Does `version` satisfy `op` + `target`? Shared by the bundled and live scans. */
export interface InstallerConstraint {
  operator: '^' | '~' | '>=' | '<=' | '>' | '<' | '='
  target: string
}

export function parseInstallerConstraint(constraint: string): InstallerConstraint | null {
  const match = constraint.match(/^([~^]|>=|<=|>|<|=)(\d+(?:\.\d+){0,10}(?:-[0-9A-Za-z.-]+)?(?:[+_][0-9A-Za-z.-]+)?)/)
  if (!match) return null
  return { operator: match[1] as InstallerConstraint['operator'], target: match[2] }
}

function numericCore(version: string): number[] {
  return version.split(/[+_-]/, 1)[0].split('.').map(part => Number.parseInt(part, 10))
}

function compareInstallerVersions(a: string, b: string): number {
  const left = numericCore(a)
  const right = numericCore(b)
  for (let i = 0; i < Math.max(left.length, right.length, 3); i++) {
    const difference = (left[i] || 0) - (right[i] || 0)
    if (difference) return difference
  }

  const leftPrerelease = a.includes('-')
  const rightPrerelease = b.includes('-')
  if (leftPrerelease !== rightPrerelease) return leftPrerelease ? -1 : 1

  const leftDev = Number.parseInt(a.match(/-dev\.(\d+)/)?.[1] || '0', 10)
  const rightDev = Number.parseInt(b.match(/-dev\.(\d+)/)?.[1] || '0', 10)
  return leftDev - rightDev
}

export function satisfiesInstallerConstraint(version: string, constraint: InstallerConstraint): boolean {
  const { operator: op, target: targetRaw } = constraint
  // Skip dev/pre-release versions for stable constraints
  if (version.includes('-') && !targetRaw.includes('-')) return false
  const parts = numericCore(version)
  const target = numericCore(targetRaw)
  if (parts.some(Number.isNaN) || target.some(Number.isNaN)) return false

  // A partial constraint omits components ("^26", "~1.3"), so read every slot
  // through a 0 default on BOTH sides. Comparing against a bare target[1] made
  // each test `x > undefined` — always false — so "^26" matched nothing and the
  // caller silently installed "latest" instead of a node 26.
  const [vMaj, vMin, vPat] = [parts[0] || 0, parts[1] || 0, parts[2] || 0]
  const [tMaj, tMin, tPat] = [target[0] || 0, target[1] || 0, target[2] || 0]
  const order = compareInstallerVersions(version, targetRaw)

  if (op === '^') {
    if (order < 0) return false
    // ^0.0.3 pins the patch; ^0.15.1 pins the minor; ^1.2.3 pins the major.
    if (tMaj === 0 && tMin === 0) return vMaj === 0 && vMin === 0 && vPat === tPat
    if (tMaj === 0) return vMaj === 0 && vMin === tMin
    // ^x.y.z: same major, minor.patch >= target
    return vMaj === tMaj
  }
  if (op === '~') {
    if (order < 0) return false
    return target.length === 1 ? vMaj === tMaj : vMaj === tMaj && vMin === tMin
  }
  if (op === '>=') return order >= 0
  if (op === '<=') return order <= 0
  if (op === '>') return order > 0
  if (op === '<') return order < 0
  if (op === '=') return order === 0
  return false
}

/**
 * Live version list for the domains that publish one, newest-first.
 *
 * The bundled catalog in `packages/index.js` is a point-in-time snapshot: it
 * goes stale the moment upstream cuts a release (bun.sh tops out at 1.3.0
 * there while 1.3.14 is current), so a constraint like `^1.3.14` matched
 * nothing and we silently installed "latest" instead. Consulting upstream
 * keeps a correct `deps.yaml` pin from depending on when this package was
 * last published. Returns [] for domains with no live source — the bundled
 * list is then the only answer.
 */
async function fetchLiveVersions(domain: string): Promise<string[]> {
  if (domain === 'bun.sh') {
    const resp = await fetchJSON('https://api.github.com/repos/oven-sh/bun/releases?per_page=100').catch(() => null)
    const releases = (resp as Array<{ tag_name?: string }> | null) || []
    return releases.map(r => (r.tag_name || '').replace(/^bun-v/, '')).filter(Boolean)
  }
  if (domain === 'nodejs.org') {
    const resp = await fetchJSON('https://nodejs.org/dist/index.json').catch(() => null)
    const versions = (resp as Array<{ version?: string }> | null) || []
    return versions.map(v => (v.version || '').replace(/^v/, '')).filter(Boolean)
  }
  if (domain === 'ziglang.org') return registryVersions(domain)
  return []
}

/** Newest-first semver sort, so the first match found is always the highest. */
export function compareInstallerVersionsDesc(a: string, b: string): number {
  return compareInstallerVersions(b, a)
}

export function resolveInstallerConstraintFromCandidates(constraint: string, candidates: readonly string[]): string | null {
  const parsed = parseInstallerConstraint(constraint)
  if (!parsed) return null
  return [...new Set(candidates)].sort(compareInstallerVersionsDesc).find(version => satisfiesInstallerConstraint(version, parsed)) || null
}

/**
 * Resolve a semver constraint (^1.0.0, ~1.2.0, >=1.0.0, etc.) to the best matching concrete version.
 */
async function resolveVersionConstraint(domain: string, constraint: string): Promise<string> {
  if (!parseInstallerConstraint(constraint)) return resolveLatestVersion(domain)

  // Get available versions from package metadata
  let bundledVersions: readonly string[]
  try {
    const pkgKey = domain.replace(/[^a-z0-9]/gi, '').toLowerCase()
    const { packages } = await import('./packages/index.js').catch(() => import('./index.js'))
    const pkg = (packages as any)[pkgKey]
    bundledVersions = pkg?.versions || []
  }
  catch {
    bundledVersions = []
  }

  // Union of upstream + bundled, sorted so the first match is the highest one.
  // Merging rather than preferring either list keeps resolution working when
  // upstream is unreachable (bundled-only) and when it's ahead (live-only).
  const live = await fetchLiveVersions(domain)
  const candidates = [...new Set([...live, ...bundledVersions])].sort(compareInstallerVersionsDesc)
  const resolved = resolveInstallerConstraintFromCandidates(constraint, candidates)
  if (resolved) return resolved

  // Nothing upstream or bundled satisfies the pin. Installing "latest" here
  // would hand back a version the caller explicitly did not ask for, which is
  // worse than stopping: a `^1.2` pin quietly became 1.3.x.
  throw new Error(
    `No version of ${domain} satisfies "${constraint}" `
    + `(checked ${candidates.length} version${candidates.length === 1 ? '' : 's'}`
    + `${candidates.length > 0 ? `, newest ${candidates[0]}` : ''}).`,
  )
}

// ── Helpers ──

function downloadFile(url: string, dest: string, maxRedirects = 10, quiet = false): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest)
    const get = url.startsWith('https') ? https.get : http.get
    const showProgress = !quiet && process.stderr.isTTY

    // Stall watchdog — abort if no bytes arrive for 60s. Without this,
    // a hung TCP connection makes `pantry install` look like it's
    // frozen forever instead of failing with a clear error.
    let lastDataAt = Date.now()
    let received = 0
    let total = 0
    let lastPrintAt = 0
    const STALL_MS = 60_000

    const req = get(url, (res) => {
      // Handle redirects
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close()
        try { fs.unlinkSync(dest) } catch { /* ignore */ }
        if (maxRedirects <= 0) return reject(new Error(`Too many redirects for ${url}`))
        return downloadFile(res.headers.location, dest, maxRedirects - 1, quiet).then(resolve, reject)
      }

      if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
        file.close()
        try { fs.unlinkSync(dest) } catch { /* ignore */ }
        return reject(new Error(`HTTP ${res.statusCode || 'unknown'} downloading ${url}`))
      }

      const contentLength = res.headers['content-length']
      if (contentLength) total = Number.parseInt(contentLength, 10) || 0

      res.on('data', (chunk: Buffer) => {
        lastDataAt = Date.now()
        received += chunk.length
        if (showProgress && lastDataAt - lastPrintAt > 200) {
          lastPrintAt = lastDataAt
          const mb = (received / 1_048_576).toFixed(1)
          if (total > 0) {
            const totalMb = (total / 1_048_576).toFixed(1)
            const pct = Math.floor((received / total) * 100)
            process.stderr.write(`\r    ${mb}/${totalMb} MB (${pct}%)`)
          }
          else {
            process.stderr.write(`\r    ${mb} MB`)
          }
        }
      })

      res.pipe(file)
      res.on('error', (err) => {
        file.close()
        try { fs.unlinkSync(dest) } catch { /* ignore */ }
        reject(err)
      })
      file.on('finish', () => {
        file.close()
        if (showProgress && lastPrintAt > 0) process.stderr.write('\r\x1b[K')
        resolve()
      })
      file.on('error', (err) => {
        try { fs.unlinkSync(dest) } catch { /* ignore */ }
        reject(err)
      })
    })

    req.on('error', (err) => {
      file.close()
      try { fs.unlinkSync(dest) } catch { /* ignore */ }
      reject(err)
    })

    // Drive the stall timer off setInterval so we surface a clean
    // error message instead of relying on the OS-level socket timeout
    // (which on macOS can be 60+ seconds with no visible feedback).
    const stallTimer = setInterval(() => {
      if (Date.now() - lastDataAt > STALL_MS) {
        clearInterval(stallTimer)
        req.destroy(new Error(`Download stalled (no data for ${STALL_MS / 1000}s): ${url}`))
      }
    }, 5_000)
    const clearStall = () => clearInterval(stallTimer)
    file.once('finish', clearStall)
    file.once('error', clearStall)
    req.once('error', clearStall)
  })
}

async function extractArchive(archivePath: string, destDir: string, format: string): Promise<void> {
  if (format === 'zip') {
    // Use system unzip (available on all platforms)
    if (process.platform === 'win32') {
      execFileSync('powershell', ['-NoProfile', '-Command', 'Expand-Archive', '-Path', archivePath, '-DestinationPath', destDir, '-Force'], { stdio: 'pipe' })
    }
    else {
      execFileSync('unzip', ['-o', '-q', archivePath, '-d', destDir], { stdio: 'pipe' })
    }
  }
  else if (format === 'tar.xz') {
    execFileSync('tar', ['xJf', archivePath, '-C', destDir], { stdio: 'pipe' })
  }
  else if (format === 'tar.gz') {
    execFileSync('tar', ['xzf', archivePath, '-C', destDir], { stdio: 'pipe' })
  }
  else {
    throw new Error(`Unsupported archive format: ${format}`)
  }
}

function copyDirRecursive(src: string, dest: string): void {
  fs.cpSync(src, dest, { recursive: true })
}

function fetchJSON(url: string, maxRedirects = 5): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const get = url.startsWith('https') ? https.get : http.get
    const headers: Record<string, string> = {
      'User-Agent': 'pantry-installer',
      'Accept': 'application/json',
    }
    // Authenticate api.github.com calls when a GITHUB_TOKEN is available.
    // Unauthenticated requests share a 60 req/hr quota across the entire
    // runner pool's IP range, which is routinely exhausted on busy CI;
    // an authenticated request gets 5000/hr per token. The token is set
    // automatically on GitHub Actions runners — outside CI we just skip.
    if (url.includes('api.github.com')) {
      const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
      if (token) headers.Authorization = `Bearer ${token}`
    }
    const req = get(url, { headers, timeout: 30000 }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (maxRedirects <= 0) return reject(new Error(`Too many redirects for ${url}`))
        return fetchJSON(res.headers.location, maxRedirects - 1).then(resolve, reject)
      }
      if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
        return reject(new Error(`HTTP ${res.statusCode || 'unknown'} fetching ${url}`))
      }
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        try { resolve(JSON.parse(data)) }
        catch (e) { reject(e) }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => {
      req.destroy()
      reject(new Error(`Request timed out: ${url}`))
    })
  })
}

/**
 * Check if a package domain has a known resolver.
 */
export function isSupported(domain: string): boolean {
  return domain in resolvers
}

/**
 * Get list of all supported package domains.
 */
export function supportedPackages(): string[] {
  return Object.keys(resolvers)
}

/**
 * Get the primary binary name for a supported package domain.
 * Returns the first non-Windows binary (e.g. 'bun' for 'bun.sh', 'zig' for 'ziglang.org').
 */
export function getPrimaryBinary(domain: string): string | undefined {
  const resolver = resolvers[domain]
  if (!resolver) return undefined
  const platform = detectPlatform()
  const bins = resolver.getBinaries(platform)
  return bins[0]
}
