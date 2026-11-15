import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { packageDomain, parseBuildSummaryFailures, parsePublicationResult, PUBLICATION_RESULT_TITLE, versionsChanged } from '../../packages/ts-pantry/scripts/changed-package-domains'
import { createGitHubApi } from './github-api'

export const publicationDirectory = '.github/catalog-publications'
const receiptPrefix = 'refs/tags/catalog-published/'
// A request that gave up, and whose every package a later request names. The
// later request is where that package's publication is tracked from then on.
const supersededPrefix = 'refs/tags/catalog-superseded/'
interface Publication { id: string, domains: string[] }
interface Run { id: number, display_title: string, event: string, path: string, status: string, conclusion: string | null, updated_at: string, head_repository: { full_name: string } }
interface RecoveryOptions {
  repository: string
  api: (path: string, init?: RequestInit, budgetMs?: number) => Promise<any>
  receipt: (id: string, sha: string) => Promise<void>
  now?: () => number
  retryFailed?: boolean
  createdAfter?: string
  /** The later requests that between them name every one of `domains`, or none: see `laterRequestsCovering`. */
  covering?: (domains: string[]) => string[]
  supersede?: (id: string, sha: string) => Promise<void>
  /** A job's log as text, or null when it cannot be had. Read only for a red job that left no annotation. */
  jobLog?: (jobId: number) => Promise<string | null>
}

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.toString()}`)
  return result.stdout.toString().trim()
}

/**
 * What a receipt or a superseded tag points at: a blob that holds the source
 * commit's id, not the commit.
 *
 * A tag on the commit itself is refused when the workflow's own token pushes
 * it and that commit's workflow files are not the ones main has now ("refusing
 * to allow a GitHub App to create or update workflow"): which is any request
 * older than the last workflow change. A blob carries no workflow files, and
 * names the source as exactly. Tags that point at the commit, from before
 * this, are still read.
 */
function sourceMarker(cwd: string, sha: string, write = false): string {
  const result = Bun.spawnSync(['git', 'hash-object', ...(write ? ['-w'] : []), '--stdin'], { cwd, stdin: Buffer.from(`${sha}\n`), stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(`git hash-object failed: ${result.stderr.toString()}`)
  return result.stdout.toString().trim()
}

/** Records `prefix``id` for the request whose source is `sha`. */
export function markPublication(cwd: string, prefix: 'published' | 'superseded', id: string, sha: string): void {
  git(cwd, 'push', 'origin', `${sourceMarker(cwd, sha, true)}:${prefix === 'published' ? receiptPrefix : supersededPrefix}${id}`)
}

export function parsePublication(raw: string): Publication {
  const value = JSON.parse(raw) as Publication
  if (!/^[0-9]+-[0-9]+$/.test(value.id) || !Array.isArray(value.domains) || !value.domains.length
    || value.domains.some(domain => typeof domain !== 'string' || !/^[a-zA-Z0-9._/-]{1,128}$/.test(domain))
    || new Set(value.domains).size !== value.domains.length)
    throw new Error('Invalid catalog publication request')
  return value
}

/** Request identities are `<workflow run>-<attempt>`: later runs have larger numbers. */
function requestOrder(a: string, b: string): number {
  const [runA, attemptA] = a.split('-').map(Number)
  const [runB, attemptB] = b.split('-').map(Number)
  return runA! - runB! || attemptA! - attemptB!
}

/**
 * The later requests that name the domains of `publication`, when between them
 * they name all of them; otherwise none.
 *
 * A package whose build is broken fails every request it is in. Each of its
 * releases adds another request, each is retried three times, and each then
 * stays, reported as failed every hour: twenty-seven of them at the time this
 * was written, for four broken recipes. Only the newest request says anything
 * that is still true about such a package, so an older one that has given up
 * hands its packages to the later ones and is retired.
 */
export function laterRequestsCovering(publication: Publication, all: readonly Publication[]): string[] {
  const later = all.filter(other => requestOrder(other.id, publication.id) > 0)
  const covering = new Set<string>()
  for (const domain of publication.domains) {
    const by = later.find(other => other.domains.includes(domain))
    if (!by) return []
    covering.add(by.id)
  }
  return [...covering].sort(requestOrder)
}

function remoteTags(cwd: string, prefix: string): Map<string, string> {
  return new Map(git(cwd, 'ls-remote', 'origin', `${prefix}*`).split('\n').filter(Boolean)
    .map(line => { const [sha, ref] = line.split(/\s+/); return [ref!.slice(prefix.length), sha!] }))
}

export async function pendingPublications(cwd: string): Promise<Array<Publication & { sha: string }>> {
  const directory = join(cwd, publicationDirectory)
  const files = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  const receipts = remoteTags(cwd, receiptPrefix)
  const superseded = remoteTags(cwd, supersededPrefix)
  const pending = []
  for (const file of files.filter(file => file.endsWith('.json')).sort()) {
    const path = `${publicationDirectory}/${file}`
    const raw = await readFile(join(cwd, path), 'utf8')
    const publication = parsePublication(raw)
    if (file !== `${publication.id}.json`) throw new Error('Publication filename must match its identity')
    const sha = git(cwd, 'log', '-1', '--format=%H', '--', path)
    if (!sha) throw new Error('Recovery requires a committed publication request')
    if (git(cwd, 'show', `${sha}:${path}`) !== raw.trim()) throw new Error('Publication requests must be immutable')
    const names = (target: string | undefined) => target === sha || target === sourceMarker(cwd, sha)
    if (names(receipts.get(publication.id))) continue
    if (receipts.has(publication.id)) throw new Error('Publication receipt points to a different source commit')
    if (names(superseded.get(publication.id))) continue
    if (superseded.has(publication.id)) throw new Error('Superseded publication points to a different source commit')
    pending.push({ ...publication, sha })
  }
  return pending
}

/** Commit the handoff with the metadata, closing the crash-after-push gap. */
export async function preparePublications(cwd: string, id: string, claimedDomains: string[] = []): Promise<void> {
  if (!/^[0-9]+-[0-9]+$/.test(id)) throw new Error('Expected workflow run ID and attempt')
  const directory = join(cwd, publicationDirectory)
  await mkdir(directory, { recursive: true })
  const pending = new Set((await pendingPublications(cwd)).map(p => p.id))
  for (const file of await readdir(directory)) {
    if (file.endsWith('.json') && !pending.has(file.slice(0, -5))) await unlink(join(directory, file))
  }
  const domains = new Set<string>()
  const root = 'packages/ts-pantry/src/packages/'
  const changed = [git(cwd, 'diff', '--name-only', 'HEAD', '--', root), git(cwd, 'ls-files', '--others', '--exclude-standard', '--', root)]
  for (const path of new Set(changed.join('\n').split('\n').filter(Boolean))) {
    if (!path.endsWith('.ts') || path.startsWith(`${root}apps/`) || path.startsWith(`${root}fonts/`)) continue
    const after = await readFile(join(cwd, path), 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (!after) continue
    const domain = packageDomain(after)
    if (!domain) continue
    const exists = Bun.spawnSync(['git', 'cat-file', '-e', `HEAD:${path}`], { cwd, stdout: 'pipe', stderr: 'pipe' }).exitCode === 0
    const before = exists ? git(cwd, 'show', `HEAD:${path}`) : null
    if (versionsChanged(before, after)) domains.add(domain)
  }
  // A rebuild notification is work even if a previous run already recorded
  // the version. Hand it off durably before acknowledging the release lease.
  const requested = new Set(claimedDomains)
  if ([...requested].some(domain => !/^[a-zA-Z0-9._/-]{1,128}$/.test(domain)))
    throw new Error('Invalid claimed publication domain')
  for (const file of new Bun.Glob('**/*.ts').scanSync({ cwd: join(cwd, root), onlyFiles: true })) {
    if (!requested.size) break
    if (file.startsWith('apps/') || file.startsWith('fonts/')) continue
    const domain = packageDomain(await readFile(join(cwd, root, file), 'utf8'))
    if (domain && requested.delete(domain)) domains.add(domain)
  }
  if (requested.size) throw new Error(`No portable package metadata for claimed releases: ${[...requested].join(', ')}`)
  if (domains.size) {
    const publication = { id, domains: [...domains].sort() }
    await writeFile(join(directory, `${id}.json`), `${JSON.stringify(publication, null, 2)}\n`, { flag: 'wx' })
  }
}

/**
 * The packages a publication run could not publish, from what its publisher
 * jobs annotated (`PUBLICATION_RESULT_TITLE`). null when any publisher job that
 * ran says nothing readable: a run from before the annotation, or a job that
 * died before it got that far. Every package of the request is in doubt then.
 */
export async function failedDomains(runId: number, options: Pick<RecoveryOptions, 'repository' | 'api' | 'jobLog'>): Promise<string[] | null> {
  const { repository, api } = options
  const result = await api(`repos/${repository}/actions/runs/${runId}/jobs?filter=latest&per_page=100`)
  const publishers = (result.jobs as any[]).filter(job => /^Publish (\(|darwin)/.test(job.name) && job.conclusion !== 'skipped')
  if (!publishers.length) return null
  const failed = new Set<string>()
  for (const job of publishers) {
    const annotations = await api(`repos/${repository}/check-runs/${job.id}/annotations?per_page=100`) as Array<{ title?: string, message?: string }>
    if (!Array.isArray(annotations)) return null
    const reported = annotations.filter(annotation => annotation.title === PUBLICATION_RESULT_TITLE)
    if (!reported.length) {
      // A source commit older than the annotation: its build script cannot
      // write one. A green job delivered what it was asked; a red one still
      // lists what failed at the end of its log.
      if (job.conclusion === 'success') continue
      const log = job.conclusion === 'failure' ? await options.jobLog?.(job.id) : null
      const listed = log ? parseBuildSummaryFailures(log) : null
      if (!listed) return null
      for (const domain of listed) failed.add(domain)
      continue
    }
    for (const annotation of reported) {
      const domains = parsePublicationResult(annotation.message ?? '')
      if (!domains) return null
      for (const domain of domains) failed.add(domain)
    }
  }
  return [...failed].sort()
}

/** Receipt tags survive workflow-log retention and do not need a main commit. */
export async function recoverPublication(publication: Publication & { sha: string }, options: RecoveryOptions): Promise<string> {
  const { repository, api } = options
  const title = `catalog:${publication.id}:${publication.sha}:all:false`
  const sourceDate = options.createdAfter ?? (await api(`repos/${repository}/commits/${publication.sha}`)).commit.committer.date
  const sourceTime = Date.parse(sourceDate)
  if (!Number.isFinite(sourceTime)) throw new Error('Expected publication source timestamp')
  // Historical unrelated runs cannot contain this request. Bound the search to
  // its source commit, allowing a minute for clock skew, rather than spending
  // the API budget scanning years of dispatches before a first publication.
  const created = encodeURIComponent(`>=${new Date(sourceTime - 60_000).toISOString()}`)
  const matches: Run[] = []
  for (let page = 1; page <= 10; page++) {
    const response = await api(`repos/${repository}/actions/workflows/publish-changed-packages.yml/runs?event=workflow_dispatch&created=${created}&per_page=100&page=${page}`) as { workflow_runs: Run[] }
    matches.push(...response.workflow_runs.filter(run => run.display_title === title
      && run.event === 'workflow_dispatch' && run.path === '.github/workflows/publish-changed-packages.yml'
      && run.head_repository.full_name === repository))
    if (response.workflow_runs.length < 100) break
    if (page === 10) throw new Error('Publication run history exceeded the recovery read limit')
  }
  if (matches.some(run => run.status !== 'completed')) return 'running'
  const successful = matches.find(run => run.conclusion === 'success')
  if (successful) {
    // A partial rerun keeps earlier successful jobs in earlier attempts. Read
    // all attempts and verify the newest execution of each required job.
    const jobs: any[] = []
    for (let page = 1; page <= 10; page++) {
      const result = await api(`repos/${repository}/actions/runs/${successful.id}/jobs?filter=all&per_page=100&page=${page}`)
      jobs.push(...result.jobs)
      if (jobs.length >= (result.total_count ?? result.jobs.length)) break
      if (!result.jobs.length || page === 10) throw new Error('Incomplete publication job read-back')
    }
    jobs.sort((a, b) => (b.id ?? 0) - (a.id ?? 0))
    for (const platform of ['linux-x86-64', 'linux-arm64']) {
      const job = jobs.find((job: any) => job.name === `Publish (${platform})`)
      if (job?.conclusion !== 'success' || !job.steps.some((step: any) => step.name === 'Publish changed packages (download-first)' && step.conclusion === 'success'))
        throw new Error(`Publication run did not publish ${platform}`)
    }
    await options.receipt(publication.id, publication.sha)
    return 'confirmed'
  }
  if (!options.retryFailed && matches.length >= 3) {
    // What is still owed is the packages its last attempt could not publish.
    // The others were delivered, in a run that is red because of these.
    const last = [...matches].sort((a, b) => b.id - a.id)[0]!
    const reported = await failedDomains(last.id, options)
    const owed = reported?.filter(domain => publication.domains.includes(domain)) ?? publication.domains
    // Each of them is in a later request: that one carries it now.
    const later = owed.length ? options.covering?.(owed) ?? [] : []
    if (later.length && options.supersede) {
      await options.supersede(publication.id, publication.sha)
      return `superseded by ${later.join(', ')} (${owed.join(', ')})`
    }
    const which = owed.length ? owed.join(', ') : 'its jobs failed without naming a package'
    throw new Error(`Publication ${publication.id} failed three times (${which}); inspect its build diagnostics before retrying manually`)
  }
  const latest = matches.sort((a, b) => b.id - a.id)[0]
  if (latest && (options.now ?? Date.now)() - Date.parse(latest.updated_at) < 60 * 60_000) return 'backoff'
  await api(`repos/${repository}/actions/workflows/publish-changed-packages.yml/dispatches`, {
    method: 'POST', body: JSON.stringify({ ref: 'main', inputs: {
      packages: publication.domains.join(','), 'request-id': publication.id, 'source-sha': publication.sha,
      platform: 'all', 'rebuild-existing': 'false', 'verify-tools-only': 'false',
    } }),
  })
  return 'dispatched'
}

/** Dispatch callbacks run before their parent workflow is fully finalized. */
export async function waitForPublisherCompletion(options: {
  repository: string, runId: string, api: RecoveryOptions['api'],
  now?: () => number, sleep?: (ms: number) => Promise<void>, budgetMs?: number,
}): Promise<void> {
  if (!/^[1-9][0-9]*$/.test(options.runId)) throw new Error('Expected publisher callback run ID')
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? Bun.sleep
  const deadline = now() + (options.budgetMs ?? 120_000)
  while (now() < deadline) {
    const run = await options.api(`repos/${options.repository}/actions/runs/${options.runId}`, {}, Math.min(30_000, deadline - now()))
    if (run.path !== '.github/workflows/publish-changed-packages.yml'
      || run.event !== 'workflow_dispatch' || run.head_repository?.full_name !== options.repository)
      throw new Error('Callback run is not the owning publication workflow')
    if (now() >= deadline) break
    if (run.status === 'completed') return
    await sleep(Math.min(5000, deadline - now()))
  }
  throw new Error('Publisher callback did not finalize within its wait budget')
}

if (import.meta.main) {
  const cwd = process.cwd()
  if (process.argv[2] === 'prepare') await preparePublications(cwd, `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`, (process.env.CLAIMED_DOMAINS ?? '').split(/\s+/).filter(Boolean))
  else {
    const repository = process.env.GITHUB_REPOSITORY ?? ''
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Expected repository')
    const api = createGitHubApi({ token: process.env.GH_TOKEN ?? '' })
    // Logs are text behind a redirect to a signed URL, which the JSON client does not read.
    const jobLog = async (jobId: number): Promise<string | null> => {
      try {
        const response = await fetch(`https://api.github.com/repos/${repository}/actions/jobs/${jobId}/logs`, {
          headers: { 'Authorization': `Bearer ${process.env.GH_TOKEN ?? ''}`, 'X-GitHub-Api-Version': '2022-11-28' }, signal: AbortSignal.timeout(60_000) })
        return response.ok ? await response.text() : null
      }
      catch { return null }
    }
    if (process.env.PUBLISHER_RUN) await waitForPublisherCompletion({ repository, runId: process.env.PUBLISHER_RUN, api })
    const failures = []
    const pending = await pendingPublications(cwd)
    for (const publication of pending) {
      try {
        git(cwd, 'merge-base', '--is-ancestor', publication.sha, 'HEAD')
        const result = await recoverPublication(publication, { repository, api, jobLog, createdAfter: git(cwd, 'show', '-s', '--format=%cI', publication.sha), retryFailed: process.env.RETRY_FAILED === 'true',
          // Only requests that are still pending take over: each is retried or reported in its own right.
          covering: domains => laterRequestsCovering({ id: publication.id, domains }, pending),
          supersede: async (id, sha) => { markPublication(cwd, 'superseded', id, sha) },
          receipt: async (id, sha) => { markPublication(cwd, 'published', id, sha) } })
        console.log(`${publication.id}: ${result}`)
      }
      catch (error) { failures.push(String(error)) }
    }
    if (failures.length) throw new Error(failures.join('\n'))
  }
}
