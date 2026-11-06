import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'bun:test'
import { verifyCheckedPushCi } from '../../../.github/scripts/checked-push-ci'

const sha = 'a'.repeat(40)
const checks = ['lint', 'typecheck', 'test', 'zig-tests']
const run = {
  id: 101, head_sha: sha, head_branch: 'chore/package-updates/1-1', event: 'workflow_dispatch',
  path: '.github/workflows/ci.yml', status: 'completed', conclusion: 'success',
  html_url: 'https://github.com/pantry-pm/pantry/actions/runs/101',
  head_repository: { full_name: 'pantry-pm/pantry' },
}
const jobs = checks.map(name => ({ name, status: 'completed', conclusion: 'success', html_url: `${run.html_url}/${name}` }))

function fixture(overrides: {
  runs?: typeof run[]
  jobs?: typeof jobs
  total?: number
  read?: (path: string) => Promise<unknown>
  report?: (sha: string, check: string, url: string) => Promise<void>
} = {}) {
  let time = 0
  const reports: string[][] = []
  const paths: string[] = []
  const options = {
    repository: 'pantry-pm/pantry', sha, branch: run.head_branch, workflow: 'ci.yml', afterRunId: 100, checks,
    budgetMs: 30_000, now: () => time, sleep: async (ms: number) => { time += ms },
    read: overrides.read ?? (async (path: string) => {
      paths.push(path)
      return path.includes('/jobs?')
        ? { total_count: overrides.total ?? (overrides.jobs ?? jobs).length, jobs: overrides.jobs ?? jobs }
        : { workflow_runs: overrides.runs ?? [run] }
    }),
    report: overrides.report ?? (async (sha: string, check: string, url: string) => { reports.push([sha, check, url]) }),
  }
  return { options, reports, paths }
}

describe('checked push CI attestation', () => {
  test('reports all required statuses on the exact SHA, linked to the verified jobs', async () => {
    const f = fixture()
    expect(await verifyCheckedPushCi(f.options)).toBe(101)
    expect(f.reports).toEqual(jobs.map(job => [sha, job.name, job.html_url]))
    expect(f.paths[0]).toContain('branch=chore%2Fpackage-updates%2F1-1&event=workflow_dispatch&head_sha=')
  })

  for (const mismatch of [
    { id: 100 }, { head_sha: 'b'.repeat(40) }, { head_branch: 'main' }, { event: 'push' },
    { path: '.github/workflows/other.yml' }, { head_repository: { full_name: 'fork/pantry' } },
  ]) {
    test(`ignores unrelated or pre-dispatch CI: ${JSON.stringify(mismatch)}`, async () => {
      const f = fixture({ runs: [{ ...run, ...mismatch }] })
      await expect(verifyCheckedPushCi(f.options)).rejects.toThrow('wait budget')
      expect(f.reports).toEqual([])
    })
  }

  test('waits for this run to finish instead of accepting an older green run', async () => {
    let reads = 0
    const f = fixture({ read: async path => {
      if (path.includes('/jobs?')) return { total_count: jobs.length, jobs }
      return { workflow_runs: [{ ...run, id: 99 }, { ...run, status: ++reads === 1 ? 'in_progress' : 'completed' }] }
    } })
    await verifyCheckedPushCi(f.options)
    expect(reads).toBe(2)
    expect(f.reports).toHaveLength(4)
  })

  for (const conclusion of ['failure', 'cancelled', 'timed_out']) {
    test(`never reports success after a ${conclusion} run`, async () => {
      const f = fixture({ runs: [{ ...run, conclusion }] })
      await expect(verifyCheckedPushCi(f.options)).rejects.toThrow(`concluded ${conclusion}`)
      expect(f.reports).toEqual([])
    })
  }

  for (const badJobs of [jobs.slice(0, 3), [...jobs, jobs[0]!],
    ...['skipped', 'neutral', 'failure'].map(conclusion => jobs.map(job => job.name === 'zig-tests' ? { ...job, conclusion } : job)),
    jobs.map(job => job.name === 'zig-tests' ? { ...job, status: 'in_progress' } : job)]) {
    test(`requires unique, executed, successful jobs: ${JSON.stringify(badJobs)}`, async () => {
      const f = fixture({ jobs: badJobs })
      await expect(verifyCheckedPushCi(f.options)).rejects.toThrow('must execute and pass')
      expect(f.reports).toEqual([])
    })
  }

  test('reads every job page before verifying', async () => {
    const f = fixture({ read: async path => {
      if (!path.includes('/jobs?')) return { workflow_runs: [run] }
      return { total_count: 4, jobs: path.endsWith('page=1') ? jobs.slice(0, 2) : jobs.slice(2) }
    } })
    await verifyCheckedPushCi(f.options)
    expect(f.reports).toHaveLength(4)
  })

  test('fails closed when job pagination is incomplete', async () => {
    const f = fixture({ jobs: [], total: 4 })
    await expect(verifyCheckedPushCi(f.options)).rejects.toThrow('Incomplete')
    expect(f.reports).toEqual([])
  })

  test('API and status publication failures abort the push gate', async () => {
    const readFailure = fixture({ read: async () => { throw new Error('API unavailable') } })
    await expect(verifyCheckedPushCi(readFailure.options)).rejects.toThrow('API unavailable')
    expect(readFailure.reports).toEqual([])
    const reportFailure = fixture({ report: async () => { throw new Error('statuses permission denied') } })
    await expect(verifyCheckedPushCi(reportFailure.options)).rejects.toThrow('statuses permission denied')
  })

  test('both callers grant status write only to their landing job', () => {
    const root = new URL('../../../.github/workflows/', import.meta.url)
    for (const [file, job] of [['update-packages.yml', 'update-packages'], ['check-desktop-updates.yml', 'record']]) {
      const workflow = Bun.YAML.parse(readFileSync(new URL(file!, root), 'utf8')) as any
      expect(workflow.jobs[job!].permissions.statuses).toBe('write')
      expect(workflow.permissions.statuses).toBeUndefined()
    }
    const updater = Bun.YAML.parse(readFileSync(new URL('update-packages.yml', root), 'utf8')) as any
    expect(updater.concurrency['cancel-in-progress']).toBe(false)
  })
})
