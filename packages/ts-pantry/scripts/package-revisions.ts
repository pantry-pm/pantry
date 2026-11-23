/**
 * A packaging repair needs a new identity even when the vendor release has not
 * changed. Numeric upstream tuples retain their original component count; one
 * additional component identifies a Pantry build revision (1.5.7 -> 1.5.7.2).
 * A release that is not a numeric tuple (3.15.0rc1, 3.6a) takes `.pantryN`
 * instead (3.15.0rc1.pantry1): no vendor writes that, and every comparison in
 * the CLI, the registry and these scripts orders it after its release and
 * before the next one (3.15.0rc1 < 3.15.0rc1.pantry1 < 3.15.0rc2 < 3.15.0).
 * Existing package identities and their installed/cache directories therefore
 * remain immutable.
 */
export type PackageRevisions = Readonly<Record<string, number>>

const numericTuple = /^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))+$/u
// Build metadata (`+sha`) carries no precedence, so a suffix after it could not order.
const otherRelease = /^\d[\w.-]*$/u

export function isNumericRelease(release: string): boolean {
  return numericTuple.test(release)
}

/** The identity of build `revision` of `release`. */
export function revisionIdentity(release: string, revision: number): string {
  return isNumericRelease(release) ? `${release}.${revision}` : `${release}.pantry${revision}`
}

function revisionSuffix(release: string): string {
  return isNumericRelease(release) ? `${release}.` : `${release}.pantry`
}

function entries(revisions: PackageRevisions = {}): Array<[string, number]> {
  const result = Object.entries(revisions)
  const lengths = new Set<number>()
  for (const [upstream, revision] of result) {
    const numeric = isNumericRelease(upstream)
    if ((!numeric && (!otherRelease.test(upstream) || upstream.includes('.pantry')))
      || !Number.isSafeInteger(revision) || revision <= 0 || revision > 0xFFFFFFFF)
      throw new Error(`Invalid package build revision: ${upstream}@${revision}`)
    if (numeric) lengths.add(upstream.split('.').length)
  }
  if (lengths.size > 1) throw new Error('Revised upstream versions must use a fixed numeric tuple length')
  return result
}

/** Discovery still asks the vendor for vendor versions; only package identities change. */
export function revisedPackageVersions(upstream: readonly string[], revisions?: PackageRevisions): string[] {
  const declared = entries(revisions)
  if (!declared.length) return [...upstream]
  for (const version of upstream) {
    // Unrelated vendor releases can shorten their tuple or publish prereleases.
    // Only a collision with a declared packaging identity is ambiguous; one
    // repair must not freeze the vendor's other release channels.
    if (declared.some(([base]) => version.startsWith(revisionSuffix(base))))
      throw new Error(`Upstream version ${version} conflicts with the recipe's package build revision format`)
  }
  return upstream.map(version => revisions?.[version] ? revisionIdentity(version, revisions[version]!) : version)
}

/** Resolve historical identities too, so reading a legacy runtime graph stays valid. */
export function recipeBuildVersion(packageVersion: string, revisions?: PackageRevisions): { upstream: string, current: string } {
  for (const [upstream, revision] of entries(revisions)) {
    const current = revisionIdentity(upstream, revision)
    if (packageVersion === upstream) return { upstream, current }
    const prefix = revisionSuffix(upstream)
    if (!packageVersion.startsWith(prefix)) continue
    const suffix = packageVersion.slice(prefix.length)
    if (!/^[1-9]\d*$/u.test(suffix) || !Number.isSafeInteger(Number(suffix)) || Number(suffix) > revision)
      throw new Error(`Undeclared package build revision: ${packageVersion}`)
    return { upstream, current }
  }
  return { upstream: packageVersion, current: packageVersion }
}

/** Never rebuild a superseded identity using a newer recipe. */
export function requireCurrentRecipeBuild(packageVersion: string, currentVersion: string): void {
  if (packageVersion !== currentVersion)
    throw new Error(`Recipe requires package build ${currentVersion}; refusing to replace ${packageVersion}`)
}

/**
 * Why a revision exists, by upstream release.
 *
 * `elf-loader-paths`: the earlier Linux build's RPATH/RUNPATH entries lost
 * `$ORIGIN` (fix-up ran patchelf through a shell before 468ded425, and mirrored
 * artifacts were not normalised before 6e7a524cc), so `bin/zstd` carried
 * `/../lib` and loaded the host's library. The vendor build itself is sound:
 * mirroring it again and normalising its loader paths
 * (`normalizeMirroredArtifact`) is the repair, and only Linux artifacts are ELF.
 */
export type RevisionReason = 'elf-loader-paths' | 'corrupt-archive'
export type PackageRevisionReasons = Readonly<Record<string, RevisionReason>>

/**
 * `corrupt-archive`: the published archive itself is damaged (akuity.io/kargo
 * 1.9.5 was republished with its bytes decoded as text), not the build, so the
 * vendor release may be mirrored again, on every platform.
 */
const knownReasons: ReadonlySet<string> = new Set<RevisionReason>(['elf-loader-paths', 'corrupt-archive'])

/** Reasons whose repair is a fresh copy of the vendor build rather than a recipe change. */
const mirrorableReasons: ReadonlySet<string> = new Set<RevisionReason>(['elf-loader-paths', 'corrupt-archive'])

/** Every reason names a declared revision and a known repair. */
export function validateRevisionReasons(revisions?: PackageRevisions, reasons?: PackageRevisionReasons): void {
  for (const [release, reason] of Object.entries(reasons ?? {})) {
    if (!revisions?.[release]) throw new Error(`Revision reason for ${release}, which has no revision`)
    if (!knownReasons.has(reason)) throw new Error(`Unknown revision reason ${reason} for ${release}`)
  }
}

/** The reason for `packageVersion` when it is a revision identity (current or historical). */
export function revisionReason(packageVersion: string, revisions?: PackageRevisions, reasons?: PackageRevisionReasons): RevisionReason | undefined {
  const { upstream } = recipeBuildVersion(packageVersion, revisions)
  return upstream === packageVersion ? undefined : reasons?.[upstream]
}

/**
 * Whether the recipe must execute for its vendor releases. A repair the
 * vendor build cannot contain (a patch, a different configuration) means it
 * must, for later releases too; a loader-path repair does not.
 */
export function recipeRequiresBuild(revisions?: PackageRevisions, reasons?: PackageRevisionReasons): boolean {
  return Object.keys(revisions ?? {}).some(release => !mirrorableReasons.has(reasons?.[release] ?? ''))
}

/** Platforms a revision is published for: a loader-path repair is Linux-only. */
export function revisionAppliesTo(reason: RevisionReason | undefined, platform: string): boolean {
  return reason !== 'elf-loader-paths' || platform.startsWith('linux-')
}

/**
 * The publishable versions for `platform`: current identities, except that
 * where a revision does not apply to the platform its published base stays.
 */
export function selectRevisionVersions(versions: readonly string[], revisions: PackageRevisions | undefined, reasons: PackageRevisionReasons | undefined, platform: string): string[] {
  if (!revisions) return [...versions]
  return versions.filter((version) => {
    const identity = recipeBuildVersion(version, revisions)
    const applies = revisionAppliesTo(reasons?.[identity.upstream], platform)
    if (identity.upstream !== identity.current && !applies)
      return version === identity.upstream
    return identity.current === version
  })
}

/** Vendor prebuilts cannot contain a Pantry packaging repair, except a loader-path or archive one. */
export function recipeAllowsMirror(packageVersion: string, identity: { upstream: string, current: string }, requiresRecipeBuild = false, reason?: RevisionReason): boolean {
  requireCurrentRecipeBuild(packageVersion, identity.current)
  if (identity.upstream === packageVersion) return !requiresRecipeBuild
  return reason !== undefined && mirrorableReasons.has(reason)
}
