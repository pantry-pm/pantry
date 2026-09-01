/**
 * The platform vocabulary, registry-side.
 *
 * This mirrors `ts-pantry/src/platforms.ts`, which is the build side's copy and
 * where the retirement decision actually originates. The registry package is
 * built standalone (`rootDir: ./src`, bundled by `bun build`), so it cannot
 * import across the package boundary without changing that boundary — a much
 * larger change than sharing four strings deserves. `platforms.test.ts` reads
 * the ts-pantry module and asserts the two agree, so the copy is checked rather
 * than merely hoped about.
 *
 * Before this module the registry carried the same list three times — in
 * `catalog.ts`, `pkgx-fallback.ts` and `storage/build-status.ts`. They were
 * identical only because nobody had changed one yet, and retiring Intel macOS
 * was the change that would have split them.
 */

/**
 * Every platform key coverage can report, retired ones included.
 *
 * Retired platforms stay here on purpose: their artifacts are still published,
 * still served and still installable, so coverage has to be able to show them.
 * Use this to report what exists; use BUILDABLE_PLATFORMS to decide what ought
 * to exist.
 */
export const ALL_PLATFORMS = ['darwin-arm64', 'darwin-x86-64', 'linux-x86-64', 'linux-arm64'] as const

/**
 * Platforms we still serve but no longer build.
 *
 * Intel macOS is retired on the build side — `orchestrate-builds.ts` and
 * `provision-build-workers.ts` both say so, and no workflow matrix has carried
 * a darwin-x86-64 leg since. Published Intel artifacts stay served; nothing new
 * is produced, so nothing is judged incomplete for lacking one.
 */
export const RETIRED_PLATFORMS = ['darwin-x86-64'] as const

/** Platforms still in production — what "complete" is measured against. */
export const BUILDABLE_PLATFORMS = ['darwin-arm64', 'linux-x86-64', 'linux-arm64'] as const

export type Platform = typeof ALL_PLATFORMS[number]

const RETIRED_SET: ReadonlySet<string> = new Set<string>(RETIRED_PLATFORMS)

/** True for a platform we still serve but no longer build. */
export function isRetiredPlatform(platform: string): boolean {
  return RETIRED_SET.has(platform)
}
