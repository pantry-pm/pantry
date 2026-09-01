/**
 * The platform vocabulary, in one place.
 *
 * These three lists were previously six literals spread across both packages —
 * `catalog.ts`, `pkgx-fallback.ts` and `build-status.ts` each carried their own
 * copy of the same four strings, while `orchestrate-builds.ts` and
 * `provision-build-workers.ts` hand-maintained the subsets they dispatch. The
 * copies were identical only because nobody had changed one yet, and retiring
 * Intel macOS was exactly the change that split them: the build side stopped
 * building it and the registry went on judging packages against it, which made
 * two thirds of its "incomplete" rows mean nothing.
 *
 * Retiring the next platform should be one edit here, not six.
 *
 * `BUILDABLE_PLATFORMS` is written out rather than derived from the other two so
 * that every list keeps its literal type — callers index records by platform and
 * take `typeof LIST[number]` unions off them, which a `.filter()` would widen to
 * `string`. `platforms.test.ts` asserts the relationship instead, so a list that
 * drifts from the other two fails a test rather than compiling quietly.
 */

/**
 * Every platform key that can appear in the registry's store.
 *
 * Includes retired platforms: their artifacts are still published, still served
 * and still installable, so coverage still has to be able to report them. Use
 * this to read or display what exists; use BUILDABLE_PLATFORMS to decide what
 * ought to.
 */
export const ALL_PLATFORMS = ['darwin-arm64', 'darwin-x86-64', 'linux-x86-64', 'linux-arm64'] as const

/**
 * Platforms we still serve but no longer build.
 *
 * Intel macOS is retired: `orchestrate-builds.ts` and `provision-build-workers.ts`
 * both say so, and no workflow matrix has carried a darwin-x86-64 leg since.
 * Published Intel artifacts stay served — nothing new is produced.
 */
export const RETIRED_PLATFORMS = ['darwin-x86-64'] as const

/**
 * Platforms still in production — what a package is judged against, what the
 * orchestrator dispatches, and what "complete" means.
 */
export const BUILDABLE_PLATFORMS = ['darwin-arm64', 'linux-x86-64', 'linux-arm64'] as const

export type Platform = typeof ALL_PLATFORMS[number]
export type BuildablePlatform = typeof BUILDABLE_PLATFORMS[number]

const RETIRED_SET: ReadonlySet<string> = new Set<string>(RETIRED_PLATFORMS)

/** True for a platform we still serve but no longer build. */
export function isRetiredPlatform(platform: string): boolean {
  return RETIRED_SET.has(platform)
}
