import { createGitHubApi } from './github-api'

interface CiRun {
  id: number
  head_sha: string
  head_branch: string
  event: string
  path: string
  status: string
  conclusion: string | null
  html_url: string
  head_repository: { full_name: string }
}

interface CiJob { name: string, status: string, conclusion: string | null, html_url: string }

interface CheckedCiOptions {
  repository: string
  sha: string
  branch: string
  workflow: string
  afterRunId: number
  checks: string[]
  read: (path: string, budgetMs: number) => Promise<unknown>
  report: (sha: string, check: string, url: string, budgetMs: number) => Promise<void>
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  budgetMs?: number
}

/** Only attest results from the CI run dispatched for this staging attempt. */
export async function verifyCheckedPushCi(options: CheckedCiOptions): Promise<number> {
  const { repository, sha, branch, workflow, afterRunId, checks, read, report } = options
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !/^[a-f0-9]{40}$/.test(sha)
    || !branch || !/^[\w.-]+\.yml$/.test(workflow)
    || !Number.isSafeInteger(afterRunId) || afterRunId < 0
    || !checks.length || checks.some(check => !check.trim()) || new Set(checks).size !== checks.length)
    throw new Error('Expected repository, exact SHA, staging branch, workflow, run baseline and unique checks')
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? Bun.sleep
  const budget = options.budgetMs ?? 40 * 60_000
  if (!Number.isSafeInteger(budget) || budget <= 0) throw new Error('Expected a positive CI wait budget')
  const deadline = now() + budget
  const withinBudget = (): void => {
    if (now() >= deadline) throw new Error(`CI verification timed out for ${sha}`)
  }
  const remaining = (): number => Math.min(30_000, Math.max(1, deadline - now()))
  while (now() < deadline) {
    const response = await read(`repos/${repository}/actions/workflows/${workflow}/runs?branch=${encodeURIComponent(branch)}&event=workflow_dispatch&head_sha=${sha}&per_page=100`, remaining()) as { workflow_runs: CiRun[] }
    const run = response.workflow_runs.filter(run => run.id > afterRunId
      && run.head_sha === sha && run.head_branch === branch && run.event === 'workflow_dispatch'
      && run.path === `.github/workflows/${workflow}` && run.head_repository.full_name === repository)
      .sort((a, b) => b.id - a.id)[0]
    if (run?.status === 'completed') {
      if (run.conclusion !== 'success') throw new Error(`Staged CI concluded ${run.conclusion}: ${run.html_url}`)
      const jobs: CiJob[] = []
      for (let page = 1; page <= 10; page++) {
        withinBudget()
        const result = await read(`repos/${repository}/actions/runs/${run.id}/jobs?per_page=100&page=${page}`, remaining()) as { total_count: number, jobs: CiJob[] }
        jobs.push(...result.jobs)
        if (jobs.length >= result.total_count) break
        if (!result.jobs.length || page === 10) throw new Error('Incomplete staged CI job read-back')
      }
      // Validate all jobs before publishing any success. A skipped job is not
      // evidence that the generated catalog passed its required checks.
      const verified = checks.map(name => {
        const matches = jobs.filter(job => job.name === name)
        if (matches.length !== 1 || matches[0]!.status !== 'completed' || matches[0]!.conclusion !== 'success')
          throw new Error(`Staged CI must execute and pass ${name}: ${run.html_url}`)
        return matches[0]!
      })
      for (const job of verified) {
        withinBudget()
        await report(sha, job.name, job.html_url, remaining())
        withinBudget()
      }
      return run.id
    }
    withinBudget()
    await sleep(Math.min(15_000, Math.max(0, deadline - now())))
  }
  throw new Error(`No successful staged CI for ${sha} within the wait budget`)
}

if (import.meta.main) {
  const repository = process.env.REPO ?? ''
  const api = createGitHubApi({ token: process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? '' })
  if (process.argv[2] === 'baseline') {
    const response = await api(`repos/${repository}/actions/workflows/${process.env.WORKFLOW ?? 'ci.yml'}/runs?per_page=1`)
    console.log(response.workflow_runs[0]?.id ?? 0)
    process.exit(0)
  }
  const runId = await verifyCheckedPushCi({
    repository, sha: process.env.CHECKED_SHA ?? '', branch: process.env.CHECKED_BRANCH ?? '',
    workflow: process.env.WORKFLOW ?? 'ci.yml', afterRunId: Number(process.env.CI_AFTER_ID),
    checks: (process.env.CHECKS ?? '').split(',').map(check => check.trim()),
    budgetMs: Number(process.env.TIMEOUT_MIN) * 60_000,
    read: (path, budgetMs) => api(path, {}, budgetMs),
    report: async (sha, check, url, budgetMs) => {
      await api(`repos/${repository}/statuses/${sha}`, { method: 'POST', body: JSON.stringify({
        state: 'success', context: check, target_url: url, description: 'Passed in verified staged CI',
      }) }, budgetMs)
      console.log(`Verified and reported ${check} on ${sha}: ${url}`)
    },
  })
  console.log(`Verified staged CI run ${runId}`)
}
