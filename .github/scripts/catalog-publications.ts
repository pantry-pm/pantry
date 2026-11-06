import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { packageDomain, versionsChanged } from '../../packages/ts-pantry/scripts/changed-package-domains'
import { createGitHubApi } from './github-api'

export const publicationDirectory = '.github/catalog-publications'
const receiptPrefix = 'refs/tags/catalog-published/'
interface Publication { id: string, domains: string[] }
interface Run { id: number, display_title: string, event: string, path: string, status: string, conclusion: string | null, updated_at: string, head_repository: { full_name: string } }
interface RecoveryOptions {
  repository: string
  api: (path: string, init?: RequestInit) => Promise<any>
  receipt: (id: string, sha: string) => Promise<void>
  now?: () => number
  retryFailed?: boolean
}

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.toString()}`)
  return result.stdout.toString().trim()
}

export function parsePublication(raw: string): Publication {
  const value = JSON.parse(raw) as Publication
  if (!/^[0-9]+-[0-9]+$/.test(value.id) || !Array.isArray(value.domains) || !value.domains.length
    || value.domains.some(domain => typeof domain !== 'string' || !/^[a-zA-Z0-9._/-]{1,128}$/.test(domain))
    || new Set(value.domains).size !== value.domains.length)
    throw new Error('Invalid catalog publication request')
  return value
}

export async function pendingPublications(cwd: string): Promise<Array<Publication & { sha: string }>> {
  const directory = join(cwd, publicationDirectory)
  const files = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  const receipts = new Map(git(cwd, 'ls-remote', 'origin', `${receiptPrefix}*`).split('\n').filter(Boolean)
    .map(line => { const [sha, ref] = line.split(/\s+/); return [ref!.slice(receiptPrefix.length), sha!] }))
  const pending = []
  for (const file of files.filter(file => file.endsWith('.json')).sort()) {
    const path = `${publicationDirectory}/${file}`
    const raw = await readFile(join(cwd, path), 'utf8')
    const publication = parsePublication(raw)
    if (file !== `${publication.id}.json`) throw new Error('Publication filename must match its identity')
    const sha = git(cwd, 'log', '-1', '--format=%H', '--', path)
    if (!sha) throw new Error('Recovery requires a committed publication request')
    if (git(cwd, 'show', `${sha}:${path}`) !== raw.trim()) throw new Error('Publication requests must be immutable')
    if (receipts.get(publication.id) === sha) continue
    if (receipts.has(publication.id)) throw new Error('Publication receipt points to a different source commit')
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

/** Receipt tags survive workflow-log retention and do not need a main commit. */
export async function recoverPublication(publication: Publication & { sha: string }, options: RecoveryOptions): Promise<string> {
  const { repository, api } = options
  const title = `catalog:${publication.id}:${publication.sha}:all:false`
  const matches: Run[] = []
  for (let page = 1; page <= 10; page++) {
    const response = await api(`repos/${repository}/actions/workflows/publish-changed-packages.yml/runs?event=workflow_dispatch&per_page=100&page=${page}`) as { workflow_runs: Run[] }
    matches.push(...response.workflow_runs.filter(run => run.display_title === title
      && run.event === 'workflow_dispatch' && run.path === '.github/workflows/publish-changed-packages.yml'
      && run.head_repository.full_name === repository))
    if (response.workflow_runs.length < 100) break
    if (page === 10) throw new Error('Publication run history exceeded the recovery read limit')
  }
  if (matches.some(run => run.status !== 'completed')) return 'running'
  const successful = matches.find(run => run.conclusion === 'success')
  if (successful) {
    const { jobs } = await api(`repos/${repository}/actions/runs/${successful.id}/jobs?per_page=100`)
    for (const platform of ['linux-x86-64', 'linux-arm64']) {
      const job = jobs.find((job: any) => job.name === `Publish (${platform})`)
      if (job?.conclusion !== 'success' || !job.steps.some((step: any) => step.name === 'Publish changed packages (download-first)' && step.conclusion === 'success'))
        throw new Error(`Publication run did not publish ${platform}`)
    }
    await options.receipt(publication.id, publication.sha)
    return 'confirmed'
  }
  if (!options.retryFailed && matches.length >= 3) throw new Error(`Publication ${publication.id} failed three times; inspect its build diagnostics before retrying manually`)
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

if (import.meta.main) {
  const cwd = process.cwd()
  if (process.argv[2] === 'prepare') await preparePublications(cwd, `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`, (process.env.CLAIMED_DOMAINS ?? '').split(/\s+/).filter(Boolean))
  else {
    const repository = process.env.GITHUB_REPOSITORY ?? ''
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Expected repository')
    const api = createGitHubApi({ token: process.env.GH_TOKEN ?? '' })
    const failures = []
    for (const publication of await pendingPublications(cwd)) {
      try {
        git(cwd, 'merge-base', '--is-ancestor', publication.sha, 'HEAD')
        const result = await recoverPublication(publication, { repository, api, retryFailed: process.env.RETRY_FAILED === 'true',
          receipt: async (id, sha) => { git(cwd, 'push', 'origin', `${sha}:${receiptPrefix}${id}`) } })
        console.log(`${publication.id}: ${result}`)
      }
      catch (error) { failures.push(String(error)) }
    }
    if (failures.length) throw new Error(failures.join('\n'))
  }
}
