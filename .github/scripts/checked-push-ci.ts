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
  read: (path: string) => Promise<unknown>
  report: (sha: string, check: string, url: string) => Promise<void>
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
  while (now() < deadline) {
    const response = await read(`repos/${repository}/actions/workflows/${workflow}/runs?branch=${encodeURIComponent(branch)}&event=workflow_dispatch&head_sha=${sha}&per_page=100`) as { workflow_runs: CiRun[] }
    const run = response.workflow_runs.filter(run => run.id > afterRunId
      && run.head_sha === sha && run.head_branch === branch && run.event === 'workflow_dispatch'
      && run.path === `.github/workflows/${workflow}` && run.head_repository.full_name === repository)
      .sort((a, b) => b.id - a.id)[0]
    if (run?.status === 'completed') {
      if (run.conclusion !== 'success') throw new Error(`Staged CI concluded ${run.conclusion}: ${run.html_url}`)
      const jobs: CiJob[] = []
      for (let page = 1; page <= 10; page++) {
        withinBudget()
        const result = await read(`repos/${repository}/actions/runs/${run.id}/jobs?per_page=100&page=${page}`) as { total_count: number, jobs: CiJob[] }
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
        await report(sha, job.name, job.html_url)
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
  const gh = async (...args: string[]): Promise<string> => {
    const child = Bun.spawn(['gh', ...args], { stdout: 'pipe', stderr: 'pipe', timeout: 30_000 })
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    if (code !== 0) throw new Error(`GitHub API request failed: ${stderr}`)
    return stdout
  }
  const runId = await verifyCheckedPushCi({
    repository, sha: process.env.CHECKED_SHA ?? '', branch: process.env.CHECKED_BRANCH ?? '',
    workflow: process.env.WORKFLOW ?? 'ci.yml', afterRunId: Number(process.env.CI_AFTER_ID),
    checks: (process.env.CHECKS ?? '').split(',').map(check => check.trim()),
    budgetMs: Number(process.env.TIMEOUT_MIN) * 60_000,
    read: async path => JSON.parse(await gh('api', path)),
    report: async (sha, check, url) => {
      await gh('api', '--method', 'POST', `repos/${repository}/statuses/${sha}`,
        '-f', 'state=success', '-f', `context=${check}`, '-f', `target_url=${url}`,
        '-f', 'description=Passed in verified staged CI')
      console.log(`Verified and reported ${check} on ${sha}: ${url}`)
    },
  })
  console.log(`Verified staged CI run ${runId}`)
}
