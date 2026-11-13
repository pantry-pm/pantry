import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { requiredSourceJobs, waitForSourceCi } from '../../../.github/scripts/source-ci-gate'

const repository = 'pantry-pm/pantry'
const sha = 'a'.repeat(40)
const completed = { id: 42, head_sha: sha, head_branch: 'main', event: 'push', path: '.github/workflows/ci.yml', head_repository: { full_name: repository }, status: 'completed', conclusion: 'success', html_url: 'https://github.com/pantry-pm/pantry/actions/runs/42' }
const jobs = () => requiredSourceJobs.map((name, id) => ({ id, name, status: 'completed', conclusion: 'success' }))


const dispatchedRun = { ...completed, head_branch: 'chore/package-updates/43459287398-1', event: 'workflow_dispatch' }
const mainSha = 'b'.repeat(40)
const mainReference = (head = sha) => ({ ref: 'refs/heads/main', object: { type: 'commit', sha: head } })
const ancestorComparison = () => ({ status: 'ahead', ahead_by: 1, behind_by: 0, total_commits: 1,
  base_commit: { sha }, merge_base_commit: { sha }, commits: [{ sha: mainSha }] })

describe('full source CI publication and deployment gate', () => {
  test('waits for the exact commit and reads every required job before admission', async () => {
    let clock = 0
    let polls = 0
    const paths: string[] = []
    const result = await waitForSourceCi({ repository, sha, now: () => clock, sleep: async ms => { clock += ms }, budgetMs: 60_000,
      read: async path => {
        paths.push(path)
        if (path.includes('/jobs?')) return { total_count: jobs().length, jobs: jobs() }
        return { workflow_runs: ++polls === 1 ? [{ ...completed, head_sha: 'b'.repeat(40) }] : polls === 2 ? [{ ...completed, status: 'in_progress', conclusion: null }] : [completed] }
      },
    })
    expect(polls).toBe(3)
    expect(result.sha).toBe(sha)
    expect(result.requiredJobs).toHaveLength(17)
    expect(paths.at(-1)).toContain('/runs/42/jobs?')
  })

  test('qualifies dispatched full source CI only after exact Main proof', async () => {
    let clock = 0
    const paths: string[] = []
    const dispatched = { ...completed, head_branch: 'chore/package-updates/43459287398-1', event: 'workflow_dispatch' }
    const result = await waitForSourceCi({ repository, sha, budgetMs: 1000,
      now: () => clock, sleep: async ms => { clock += ms },
      read: async path => {
        paths.push(path)
        const url = new URL(path, 'https://api.github.com/')
        if (url.pathname === `/repos/${repository}/actions/workflows/ci.yml/runs`) {
          if (url.searchParams.get('head_sha') !== sha) throw new Error('Expected the exact source run query')
          // Model actual GitHub query semantics: a main/push filter cannot
          // return the checked-push workflow_dispatch from its source branch.
          const selected = (!url.searchParams.has('branch') || url.searchParams.get('branch') === dispatched.head_branch)
            && (!url.searchParams.has('event') || url.searchParams.get('event') === dispatched.event)
          return { total_count: selected ? 1 : 0, workflow_runs: selected ? [dispatched] : [] }
        }
        if (path === `repos/${repository}/git/ref/heads/main`) {
          return { ref: 'refs/heads/main', node_id: 'MDM6UmVm', url: `https://api.github.com/repos/${repository}/git/refs/heads/main`,
            object: { type: 'commit', sha, url: `https://api.github.com/repos/${repository}/git/commits/${sha}` } }
        }
        if (url.pathname === `/repos/${repository}/actions/runs/${dispatched.id}/jobs`)
          return { total_count: jobs().length, jobs: jobs() }
        throw new Error(`Unexpected source CI read: ${path}`)
      },
    })
    expect(result.runId).toBe(dispatched.id)
    expect(result.sha).toBe(sha)
    expect(result.requiredJobs.map(job => job.name)).toEqual([...requiredSourceJobs])
    const mainRead = paths.indexOf(`repos/${repository}/git/ref/heads/main`)
    expect(mainRead).toBeGreaterThanOrEqual(0)
    expect(paths.findIndex(path => path.includes(`/runs/${dispatched.id}/jobs?`))).toBeGreaterThan(mainRead)
    expect(paths[0]).toBe(`repos/${repository}/actions/workflows/ci.yml/runs?head_sha=${sha}&per_page=100`)
  })

  test.each(['failure', 'cancelled', 'timed_out', 'neutral', 'skipped'])('refuses a completed %s source verdict', async conclusion => {
    await expect(waitForSourceCi({ repository, sha, read: async () => ({ workflow_runs: [{ ...completed, conclusion }] }) })).rejects.toThrow(`concluded ${conclusion}`)
  })

  test.each(['missing', 'skipped', 'failure'])('refuses %s independent publication controls even if the overall run is green', async conclusion => {
    const actual = jobs().filter(job => job.name !== 'native-publication')
    if (conclusion !== 'missing') actual.push({ id: 100, name: 'native-publication', status: 'completed', conclusion })
    await expect(waitForSourceCi({ repository, sha, read: async path => path.includes('/jobs?') ? { total_count: actual.length, jobs: actual } : { workflow_runs: [completed] } })).rejects.toThrow('must execute and pass native-publication')
  })

  for (const name of ['sdk-consumers', 'source-cli-integrations'] as const) {
    test.each(['missing', 'skipped', 'failure'])('refuses %s separated ' + name + ' checks even if the overall run is green', async conclusion => {
      const actual = jobs().filter(job => job.name !== name)
      if (conclusion !== 'missing') actual.push({ id: 100, name, status: 'completed', conclusion })
      await expect(waitForSourceCi({ repository, sha, read: async path => path.includes('/jobs?') ? { total_count: actual.length, jobs: actual } : { workflow_runs: [completed] } })).rejects.toThrow('must execute and pass ' + name)
    })
  }

  test('commit previews wait for both separated acceptance jobs', async () => {
    const workflow = Bun.YAML.parse(await readFile(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8')) as { jobs: Record<string, { needs?: string[] }> }
    expect(workflow.jobs['continuous-release']!.needs).toContain('sdk-consumers')
    expect(workflow.jobs['continuous-release']!.needs).toContain('source-cli-integrations')
  })

  test.each(['missing', 'skipped', 'duplicate', 'failed'])('refuses a %s native acceptance job even if the workflow is green', async kind => {
    const actual = jobs()
    if (kind === 'missing') actual.pop()
    else if (kind === 'duplicate') actual.push({ ...actual[0]! })
    else actual[0]!.conclusion = kind === 'skipped' ? 'skipped' : 'failure'
    await expect(waitForSourceCi({ repository, sha, read: async path => path.includes('/jobs?') ? { total_count: actual.length, jobs: actual } : { workflow_runs: [completed] } })).rejects.toThrow('must execute and pass')
  })

  test.each([{ head_branch: 'feature' }, { event: 'pull_request' }, { head_repository: { full_name: 'elsewhere/pantry' } }, { path: '.github/workflows/registry-checks.yml' }])('never substitutes a different source context %j', async patch => {
    let clock = 0
    await expect(waitForSourceCi({ repository, sha, budgetMs: 1, now: () => clock, sleep: async ms => { clock += ms }, read: async () => ({ workflow_runs: [{ ...completed, ...patch }] }) })).rejects.toThrow('No successful full source CI')
  })

  test('reads all job pages and rejects incomplete read-back', async () => {
    let pages = 0
    const result = await waitForSourceCi({ repository, sha, read: async path => {
      if (!path.includes('/jobs?')) return { workflow_runs: [completed] }
      pages++
      return { total_count: 15, jobs: pages === 1 ? jobs().slice(0, 7) : jobs().slice(7) }
    } })
    expect(pages).toBe(2)
    expect(result.requiredJobs).toHaveLength(17)
    await expect(waitForSourceCi({ repository, sha, read: async path => path.includes('/jobs?') ? { total_count: 15, jobs: [] } : { workflow_runs: [completed] } })).rejects.toThrow('Incomplete source CI')
  })

  test('bounds API reads by one deadline and refuses a late successful response', async () => {
    let clock = 0
    const budgets: number[] = []
    await expect(waitForSourceCi({ repository, sha, budgetMs: 1000, now: () => clock, read: async (...args) => {
      budgets.push(args[1])
      clock += 1001
      return { workflow_runs: [completed] }
    } })).rejects.toThrow('exceeded its wait budget')
    expect(budgets).toEqual([1000])
  })

  test('both maintained workflows require full CI before deployment or any publication', async () => {
    const release = Bun.YAML.parse(await readFile(new URL('../../../.github/workflows/release.yml', import.meta.url), 'utf8')) as any
    const deploy = Bun.YAML.parse(await readFile(new URL('../../../.github/workflows/deploy-registry.yml', import.meta.url), 'utf8')) as any
    for (const workflow of [release, deploy]) {
      expect(workflow.jobs['source-ci']?.uses).toBe('./.github/workflows/source-ci-gate.yml')
      expect(workflow.permissions.actions).toBe('read')
    }
    expect([release.jobs.pantry.needs].flat()).toContain('source-ci')
    expect([deploy.jobs.deploy.needs].flat()).toContain('source-ci')
    expect([deploy.jobs.deploy.needs].flat()).toContain('verify')
  })
  test('qualifies an owned dispatch whose exact source is an ancestor of the exact Main head', async () => {
    const paths: string[] = []
    const result = await waitForSourceCi({ repository, sha, read: async path => {
      paths.push(path)
      if (path.includes('/workflows/ci.yml/runs?')) return { workflow_runs: [dispatchedRun] }
      if (path === `repos/${repository}/git/ref/heads/main`) return mainReference(mainSha)
      if (path === `repos/${repository}/compare/${sha}...${mainSha}`) return ancestorComparison()
      if (path.includes('/runs/42/jobs?')) return { total_count: jobs().length, jobs: jobs() }
      throw new Error(`Unexpected source CI read: ${path}`)
    } })
    expect(result.runId).toBe(42)
    expect(result.requiredJobs).toHaveLength(17)
    expect(result.mainLineage).toEqual({ source: sha, mainHead: mainSha, kind: 'ancestor-of-main' })
    expect(paths).toEqual([`repos/${repository}/actions/workflows/ci.yml/runs?head_sha=${sha}&per_page=100`,
      `repos/${repository}/git/ref/heads/main`, `repos/${repository}/compare/${sha}...${mainSha}`,
      `repos/${repository}/actions/runs/42/jobs?per_page=100&page=1`])
  })

  test.each([
    { name: 'unmerged source', proof: { ...ancestorComparison(), status: 'behind' } },
    { name: 'diverged source', proof: { ...ancestorComparison(), status: 'diverged' } },
    { name: 'inconsistent identical distinct SHAs', proof: { ...ancestorComparison(), status: 'identical' } },
    { name: 'wrong exact base', proof: { ...ancestorComparison(), base_commit: { sha: mainSha } } },
    { name: 'wrong merge base', proof: { ...ancestorComparison(), merge_base_commit: { sha: mainSha } } },
    { name: 'nonzero behind count', proof: { ...ancestorComparison(), behind_by: 1 } },
    { name: 'zero ahead count', proof: { ...ancestorComparison(), ahead_by: 0 } },
    { name: 'fractional ahead count', proof: { ...ancestorComparison(), ahead_by: 1.5 } },
    { name: 'missing comparison', proof: null },
  ])('refuses dispatch Main lineage with $name', async ({ proof }) => {
    const paths: string[] = []
    await expect(waitForSourceCi({ repository, sha, read: async path => {
      paths.push(path)
      if (path.includes('/workflows/ci.yml/runs?')) return { workflow_runs: [dispatchedRun] }
      if (path === `repos/${repository}/git/ref/heads/main`) return mainReference(mainSha)
      if (path === `repos/${repository}/compare/${sha}...${mainSha}`) return proof
      throw new Error(`Unexpected source CI read: ${path}`)
    } })).rejects.toThrow('must be an exact ancestor of Main')
    expect(paths.some(path => path.includes('/jobs?'))).toBe(false)
  })

  test.each([
    { name: 'missing reference', reference: null },
    { name: 'different reference', reference: { ...mainReference(), ref: 'refs/heads/feature' } },
    { name: 'missing object', reference: { ref: 'refs/heads/main', object: null } },
    { name: 'tag object', reference: { ref: 'refs/heads/main', object: { type: 'tag', sha } } },
    { name: 'short SHA', reference: mainReference(sha.slice(1)) },
    { name: 'non-string SHA', reference: { ref: 'refs/heads/main', object: { type: 'commit', sha: 7 } } },
    { name: 'noncanonical SHA', reference: mainReference('A'.repeat(40)) },
  ])('refuses dispatch with $name Main proof', async ({ reference }) => {
    const paths: string[] = []
    await expect(waitForSourceCi({ repository, sha, read: async path => {
      paths.push(path)
      if (path.includes('/workflows/ci.yml/runs?')) return { workflow_runs: [dispatchedRun] }
      if (path === `repos/${repository}/git/ref/heads/main`) return reference
      throw new Error(`Unexpected source CI read: ${path}`)
    } })).rejects.toThrow('authoritative Main commit reference')
    expect(paths.some(path => path.includes('/jobs?') || path.includes('/compare/'))).toBe(false)
  })

  test.each(['main reference', 'ancestor comparison'])('preserves unavailable %s proof as failure', async phase => {
    await expect(waitForSourceCi({ repository, sha, read: async path => {
      if (path.includes('/workflows/ci.yml/runs?')) return { workflow_runs: [dispatchedRun] }
      if (path === `repos/${repository}/git/ref/heads/main`) {
        if (phase === 'main reference') throw new Error('Source CI read-back HTTP 403')
        return mainReference(mainSha)
      }
      if (path === `repos/${repository}/compare/${sha}...${mainSha}`) throw new Error('Source CI read-back HTTP 403')
      throw new Error(`Unexpected source CI read: ${path}`)
    } })).rejects.toThrow('Source CI read-back HTTP 403')
  })

  test.each(['missing', 'skipped', 'failure'])('requires all17 jobs after dispatch lineage, including %s publication control', async conclusion => {
    const actual = jobs().filter(job => job.name !== 'native-publication')
    if (conclusion !== 'missing') actual.push({ id: 100, name: 'native-publication', status: 'completed', conclusion })
    await expect(waitForSourceCi({ repository, sha, read: async path => {
      if (path.includes('/workflows/ci.yml/runs?')) return { workflow_runs: [dispatchedRun] }
      if (path === `repos/${repository}/git/ref/heads/main`) return mainReference()
      if (path.includes('/runs/42/jobs?')) return { total_count: actual.length, jobs: actual }
      throw new Error(`Unexpected source CI read: ${path}`)
    } })).rejects.toThrow('must execute and pass native-publication')
  })

  test('never substitutes older green CI for the latest owned dispatch failure', async () => {
    const paths: string[] = []
    await expect(waitForSourceCi({ repository, sha, read: async path => {
      paths.push(path)
      if (path.includes('/workflows/ci.yml/runs?')) return { workflow_runs: [completed, { ...dispatchedRun, id: 43, conclusion: 'failure' }] }
      throw new Error(`Unexpected admission of failed source: ${path}`)
    } })).rejects.toThrow('Exact source CI concluded failure')
    expect(paths).toHaveLength(1)
  })

  test.each(['main reference', 'ancestor comparison'])('keeps one deadline during dispatch %s', async phase => {
    let clock = 0
    const paths: string[] = []
    const budgets: number[] = []
    await expect(waitForSourceCi({ repository, sha, budgetMs: 1000, now: () => clock, read: async (path, remaining) => {
      paths.push(path)
      budgets.push(remaining)
      if (path.includes('/workflows/ci.yml/runs?')) return { workflow_runs: [dispatchedRun] }
      if (path === `repos/${repository}/git/ref/heads/main`) {
        if (phase === 'main reference') clock += 1001
        return mainReference(phase === 'main reference' ? sha : mainSha)
      }
      if (path === `repos/${repository}/compare/${sha}...${mainSha}`) {
        clock += 1001
        return ancestorComparison()
      }
      throw new Error(`Unexpected late admission: ${path}`)
    } })).rejects.toThrow('exceeded its wait budget')
    expect(paths.some(path => path.includes('/jobs?'))).toBe(false)
    expect(budgets.every(value => value > 0 && value <= 1000)).toBe(true)
  })

  test.each([
    { head_branch: '' }, { head_branch: '  ' }, { head_sha: mainSha },
    { head_repository: { full_name: 'elsewhere/pantry' } }, { path: '.github/workflows/registry-checks.yml' },
  ])('never admits an unowned or incomplete dispatch context %j', async patch => {
    let clock = 0
    const paths: string[] = []
    await expect(waitForSourceCi({ repository, sha, budgetMs: 1, now: () => clock, sleep: async ms => { clock += ms }, read: async path => {
      paths.push(path)
      return { workflow_runs: [{ ...dispatchedRun, ...patch }] }
    } })).rejects.toThrow('No successful full source CI')
    expect(paths.some(path => path.includes('/git/ref/') || path.includes('/jobs?'))).toBe(false)
  })

})
