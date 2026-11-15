import { join } from 'node:path'

const REPO_ROOT = join(import.meta.dir, '..', '..', '..')
const PACKAGE_ROOT = 'packages/ts-pantry/src/packages/'
const RECIPE_ROOT = 'packages/ts-pantry/src/recipes/'

function git(args: string[], cwd = REPO_ROOT): string | null {
  const result = Bun.spawnSync(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return result.exitCode === 0 ? result.stdout.toString().trim() : null
}

export function packageDomain(source: string): string | null {
  return source.match(/\bdomain:\s*['"]([^'"]+)['"]/)?.[1] ?? null
}

export function packageVersions(source: string): string[] | null {
  const body = source.match(/\bversions:\s*\[([\s\S]*?)\]\s*as const/)?.[1]
  return body == null ? null : [...body.matchAll(/['"]([^'"]+)['"]/g)].map(match => match[1]!)
}

export function versionsChanged(before: string | null, after: string | null): boolean {
  if (before == null || after == null) return before !== after
  return JSON.stringify(packageVersions(before)) !== JSON.stringify(packageVersions(after))
}

function sourceAt(ref: string, path: string, cwd: string): string | null {
  return git(['show', `${ref}:${path}`], cwd)
}

export function changedPackageDomains(beforeRef: string, afterRef: string, cwd: string = REPO_ROOT): string[] {
  const changed = git([
    'diff', '--name-only', beforeRef, afterRef, '--',
    `${RECIPE_ROOT}**`, `${PACKAGE_ROOT}**`,
  ], cwd)
  if (!changed) return []

  const domains = new Set<string>()
  for (const path of changed.split('\n').filter(Boolean)) {
    // A recipe asset belongs to the closest matching recipe, including domains
    // with slash segments. Rebuild its owner for deleted assets too.
    if (path.startsWith(`${RECIPE_ROOT}props/`)) {
      const parts = path.slice(`${RECIPE_ROOT}props/`.length).split('/')
      for (let count = parts.length - 1; count > 0; count--) {
        const recipe = `${RECIPE_ROOT}${parts.slice(0, count).join('/')}.ts`
        const source = sourceAt(afterRef, recipe, cwd) ?? sourceAt(beforeRef, recipe, cwd)
        const domain = source && packageDomain(source)
        if (domain) {
          domains.add(domain)
          break
        }
      }
      continue
    }
    const after = sourceAt(afterRef, path, cwd)
    if (after == null) continue

    if (path.startsWith(RECIPE_ROOT)) {
      const fallback = path.slice(RECIPE_ROOT.length).replace(/\.ts$/, '')
      domains.add(packageDomain(after) ?? fallback)
      continue
    }

    if (!path.startsWith(PACKAGE_ROOT) || path.startsWith(`${PACKAGE_ROOT}apps/`) || path.startsWith(`${PACKAGE_ROOT}fonts/`))
      continue

    if (versionsChanged(sourceAt(beforeRef, path, cwd), after)) {
      const domain = packageDomain(after)
      if (domain) domains.add(domain)
    }
  }

  return [...domains].sort()
}

if (import.meta.main) {
  const [beforeRef, afterRef] = process.argv.slice(2)
  if (!beforeRef || !afterRef) {
    console.error('Usage: bun changed-package-domains.ts <before-ref> <after-ref>')
    process.exit(1)
  }
  console.log(changedPackageDomains(beforeRef, afterRef).join(' '))
}

/**
 * How a publisher job says which packages it could not publish: one workflow
 * annotation with this title, whose message is their domains, comma separated
 * (`none` when every package was published or was already there).
 *
 * A request names many packages and its jobs are red when any one of them
 * fails. Recovery reads this to tell the packages that failed from the ones
 * that were delivered, which the job's conclusion alone cannot say.
 */
export const PUBLICATION_RESULT_TITLE = 'pantry-publication-result'

/** The annotation for a job that could not publish `failedDomains`. */
export function publicationResultAnnotation(failedDomains: readonly string[]): string {
  const domains = [...new Set(failedDomains)].sort()
  return domains.length
    ? `::error title=${PUBLICATION_RESULT_TITLE}::${domains.join(',')}`
    : `::notice title=${PUBLICATION_RESULT_TITLE}::none`
}

/** The domains of that annotation's message. null: not one this function wrote. */
export function parsePublicationResult(message: string): string[] | null {
  if (message === 'none') return []
  const domains = message.split(',')
  return domains.every(domain => /^[a-zA-Z0-9._/-]{1,128}$/.test(domain)) ? domains : null
}

/**
 * The domains a publisher job's own summary says failed, for a job that left no
 * annotation. A request is built from its source commit, so one older than the
 * annotation runs a build script that cannot write it, however new the
 * workflow is. Its log still ends in the summary every version of that script
 * prints:
 *
 *   Failed (2):
 *      - broken.example@1.2.3: build-package.ts exited with code 1: ...
 *   Total: 0 uploaded, 16 skipped, 0 unavailable, 2 failed
 *
 * Only the last summary is read, since a build's output comes before it and
 * could print a summary of its own, and it has to add up: as many entries as
 * its total says failed. A message that runs over several lines is one entry. null: no summary, or one that does not add up, or a
 * summary of nothing failing (the job is red for a reason it does not name).
 */
export function parseBuildSummaryFailures(log: string): string[] | null {
  const lines = log.split('\n').map(line => line.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z /, '').trimEnd())
  const start = lines.lastIndexOf('Build Summary')
  if (start < 0) return null
  const summary = lines.slice(start)
  const total = summary.map(line => line.match(/^Total: \d+ uploaded, .*\b(\d+) failed$/)).find(Boolean)
  const heading = summary.findIndex(line => /^Failed \(\d+\):$/.test(line))
  if (!total || heading < 0) return null
  const domains: string[] = []
  for (const line of summary.slice(heading + 1)) {
    if (!line) break
    // A failure's message can run over several lines; only its first names a package.
    const entry = line.match(/^ {3}- (\S+)@[^\s@]+: /)
    if (!entry) continue
    if (!/^[a-zA-Z0-9._/-]{1,128}$/.test(entry[1]!)) return null
    domains.push(entry[1]!)
  }
  if (!domains.length || domains.length !== Number(total[1])) return null
  return [...new Set(domains)].sort()
}
