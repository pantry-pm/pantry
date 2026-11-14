import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { failedDomains, laterRequestsCovering, markPublication, parsePublication, pendingPublications, preparePublications, publicationDirectory, recoverPublication, waitForPublisherCompletion } from '../../../.github/scripts/catalog-publications'

const publication = { id: '123-1', sha: 'a'.repeat(40), domains: ['curl.se'] }
const title = `catalog:${publication.id}:${publication.sha}:all:false`
const run = { id: 10, display_title: title, event: 'workflow_dispatch', path: '.github/workflows/publish-changed-packages.yml',
  status: 'completed', conclusion: 'success', updated_at: '2026-01-01T00:00:00Z', head_repository: { full_name: 'pantry-pm/pantry' } }
const jobs = ['linux-x86-64', 'linux-arm64'].map(platform => ({ name: `Publish (${platform})`, conclusion: 'success',
  steps: [{ name: 'Publish changed packages (download-first)', conclusion: 'success' }] }))

function fixture(runs: typeof run[] = []) {
  const calls: Array<{ path: string, init?: RequestInit }> = []
  const receipts: string[][] = []
  return { calls, receipts, options: { repository: 'pantry-pm/pantry', createdAfter: '2026-01-01T00:00:00Z', now: () => Date.parse('2026-01-01T02:00:00Z'),
    api: async (path: string, init?: RequestInit) => {
      calls.push({ path, init })
      return init?.method === 'POST' ? null : path.includes('/jobs?') ? { jobs } : { workflow_runs: runs }
    },
    receipt: async (id: string, sha: string) => { receipts.push([id, sha]) },
  } }
}

test('crash-after-landing recovery dispatches the exact committed source without needing another version change', async () => {
  const f = fixture()
  expect(await recoverPublication(publication, f.options)).toBe('dispatched')
  const body = JSON.parse(f.calls.at(-1)!.init!.body as string)
  expect(body.inputs['source-sha']).toBe(publication.sha)
  expect(body.inputs['request-id']).toBe(publication.id)
  expect(body.inputs.packages).toBe('curl.se')
  expect(f.receipts).toEqual([])
})

test('queued or running publications are not duplicated or acknowledged', async () => {
  const f = fixture([{ ...run, status: 'in_progress', conclusion: '' }])
  expect(await recoverPublication(publication, f.options)).toBe('running')
  expect(f.calls.every(call => !call.init)).toBe(true)
  expect(f.receipts).toEqual([])
})

test('a success confirms only this request and links its receipt to its exact source', async () => {
  const f = fixture([run])
  expect(await recoverPublication(publication, f.options)).toBe('confirmed')
  expect(f.receipts).toEqual([[publication.id, publication.sha]])
})

test('failed builds wait before retrying and retain unconfirmed work after the automatic attempt limit', async () => {
  const failed = { ...run, conclusion: 'failure' }
  const recent = fixture([{ ...failed, updated_at: '2026-01-01T01:59:00Z' }])
  expect(await recoverPublication(publication, recent.options)).toBe('backoff')
  expect(recent.receipts).toEqual([])
  const expired = fixture([failed])
  expect(await recoverPublication(publication, expired.options)).toBe('dispatched')
  const exhausted = fixture([failed, { ...failed, id: 11 }, { ...failed, id: 12 }])
  await expect(recoverPublication(publication, exhausted.options)).rejects.toThrow('failed three times')
  expect(exhausted.receipts).toEqual([])
  expect(await recoverPublication(publication, { ...exhausted.options, retryFailed: true })).toBe('dispatched')
})

test('a request that gave up is retired only when later requests name every package it names', async () => {
  const older = { id: '100-1', domains: ['broken.example', 'curl.se'] }
  const all = [older, { id: '99-1', domains: ['broken.example', 'curl.se'] }, { id: '101-1', domains: ['broken.example'] }, { id: '100-2', domains: ['curl.se'] }]
  // An earlier request never takes over, and one package without a later request keeps the request alive.
  expect(laterRequestsCovering(older, all)).toEqual(['100-2', '101-1'])
  expect(laterRequestsCovering(older, all.slice(0, 3))).toEqual([])
  expect(laterRequestsCovering(older, [older])).toEqual([])
  expect(laterRequestsCovering({ id: '9-1', domains: ['curl.se'] }, [{ id: '10-1', domains: ['curl.se'] }])).toEqual(['10-1'])

  const failed = { ...run, conclusion: 'failure' }
  const three = [failed, { ...failed, id: 11 }, { ...failed, id: 12 }]
  const superseded: string[][] = []
  const supersede = async (id: string, sha: string) => { superseded.push([id, sha]) }
  const asked: string[][] = []
  const covering = (later: string[]) => (domains: string[]) => { asked.push(domains); return later }

  // Still retried: giving up comes first, whatever later requests exist.
  const retrying = fixture([failed])
  expect(await recoverPublication(publication, { ...retrying.options, covering: covering(['124-1']), supersede })).toBe('dispatched')
  expect(superseded).toEqual([])
  expect(asked).toEqual([])

  // Its jobs say nothing readable (the fixture's have no annotations): every package is owed.
  const exhausted = fixture(three)
  expect(await recoverPublication(publication, { ...exhausted.options, covering: covering(['124-1', '125-1']), supersede })).toBe('superseded by 124-1, 125-1 (curl.se)')
  expect(asked).toEqual([['curl.se']])
  expect(superseded).toEqual([[publication.id, publication.sha]])
  expect(exhausted.receipts).toEqual([])
  expect(exhausted.calls.every(call => !call.init)).toBe(true)

  // Nothing later names its packages: it stays, and the failure says which packages.
  await expect(recoverPublication(publication, { ...fixture(three).options, covering: covering([]), supersede })).rejects.toThrow('failed three times (curl.se)')
  expect(superseded).toHaveLength(1)
})

test('what a request still owes is the packages its last attempt could not publish, not every package it names', async () => {
  const batch = { id: '200-1', sha: 'b'.repeat(40), domains: ['broken.example', 'curl.se', 'zlib.net'] }
  const failed = { ...run, display_title: `catalog:${batch.id}:${batch.sha}:all:false`, conclusion: 'failure' }
  const runs = [failed, { ...failed, id: 11 }, { ...failed, id: 12 }]
  const publishers = [
    { id: 1, name: 'Detect changed packages', conclusion: 'success' },
    { id: 2, name: 'Publish (linux-x86-64)', conclusion: 'failure' },
    { id: 3, name: 'Publish (linux-arm64)', conclusion: 'success' },
    { id: 4, name: 'Publish darwin-arm64 (native macOS)', conclusion: 'failure' },
    { id: 5, name: 'Publish desktop changes through the vendor planner', conclusion: 'skipped' },
  ]
  const result = (message: string) => [{ title: 'pantry-publication-result', message }, { title: 'something else', message: 'curl.se' }]
  function reporting(annotations: Record<number, unknown[]>) {
    const read: string[] = []
    const options = { repository: 'pantry-pm/pantry', createdAfter: '2026-01-01T00:00:00Z', now: () => Date.parse('2026-01-01T02:00:00Z'),
      receipt: async () => { throw new Error('nothing was confirmed') },
      api: async (path: string, init?: RequestInit) => {
        if (init) throw new Error('nothing may be dispatched')
        read.push(path)
        if (path.includes('/check-runs/')) return annotations[Number(path.split('/check-runs/')[1]!.split('/')[0])] ?? []
        return path.includes('/jobs?') ? { jobs: publishers } : { workflow_runs: runs }
      } }
    return { read, options }
  }

  const told = reporting({ 2: result('broken.example'), 3: result('none'), 4: result('broken.example,elsewhere.example') })
  // Read from the newest attempt, and only from the jobs that publish.
  expect(await failedDomains(12, told.options)).toEqual(['broken.example', 'elsewhere.example'])
  expect(told.read.filter(path => path.includes('/check-runs/')).map(path => path.split('/check-runs/')[1]!.split('/')[0])).toEqual(['2', '3', '4'])
  expect(told.read[0]).toContain('/actions/runs/12/jobs?filter=latest')

  // curl.se and zlib.net were delivered: only the broken package has to be in a later request.
  const asked: string[][] = []
  const superseded: string[][] = []
  const outcome = await recoverPublication(batch, { ...told.options,
    covering: (domains) => { asked.push(domains); return ['201-1'] },
    supersede: async (id, sha) => { superseded.push([id, sha]) } })
  expect(outcome).toBe('superseded by 201-1 (broken.example)')
  expect(asked).toEqual([['broken.example']])
  expect(superseded).toEqual([[batch.id, batch.sha]])

  // No later request has it: the failure names that package and no other.
  await expect(recoverPublication(batch, { ...told.options, covering: () => [], supersede: async () => {} }))
    .rejects.toThrow('failed three times (broken.example); inspect')

  // A job that says nothing, or something this code did not write, leaves every package in doubt.
  expect(await failedDomains(12, reporting({ 2: result('broken.example'), 3: result('none') }).options)).toBeNull()
  expect(await failedDomains(12, reporting({ 2: result('broken.example; rm -rf /'), 3: result('none'), 4: result('none') }).options)).toBeNull()
  await expect(recoverPublication(batch, { ...reporting({}).options, covering: () => [], supersede: async () => {} }))
    .rejects.toThrow('failed three times (broken.example, curl.se, zlib.net)')

  // Red jobs that name no package (a runner died): nothing is superseded on their word.
  const unnamed = reporting({ 2: result('none'), 3: result('none'), 4: result('none') })
  await expect(recoverPublication(batch, { ...unnamed.options, covering: () => ['201-1'], supersede: async () => { throw new Error('must not retire') } }))
    .rejects.toThrow('its jobs failed without naming a package')
})

for (const mismatch of [{ display_title: 'wrong' }, { event: 'push' }, { path: '.github/workflows/other.yml' }, { head_repository: { full_name: 'fork/pantry' } }]) {
  test(`unrelated green runs cannot acknowledge work: ${JSON.stringify(mismatch)}`, async () => {
    const f = fixture([{ ...run, ...mismatch }])
    expect(await recoverPublication(publication, f.options)).toBe('dispatched')
    expect(f.receipts).toEqual([])
  })
}

test('a green workflow with skipped publication steps cannot create a receipt', async () => {
  const f = fixture([run])
  const api = async (path: string) => path.includes('/jobs?')
    ? { jobs: jobs.map(job => ({ ...job, steps: [] })) } : { workflow_runs: [run] }
  await expect(recoverPublication(publication, { ...f.options, api })).rejects.toThrow('did not publish')
  expect(f.receipts).toEqual([])
})

test('dispatch and receipt failures propagate so the committed request stays pending', async () => {
  const f = fixture()
  await expect(recoverPublication(publication, { ...f.options, api: async (path, init) => {
    if (init) throw new Error('dispatch unavailable')
    return f.options.api(path)
  } })).rejects.toThrow('dispatch unavailable')
  const successful = fixture([run])
  await expect(recoverPublication(publication, { ...successful.options, receipt: async () => { throw new Error('git unavailable') } })).rejects.toThrow('git unavailable')
})

test('real Git outbox survives restarts, filters desktop packages, and only prunes requests with matching durable receipts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pantry-publication-'))
  const cwd = join(root, 'checkout')
  await mkdir(cwd)
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
    if (result.exitCode !== 0) throw new Error(result.stderr.toString())
    return result.stdout.toString().trim()
  }
  try {
    git('init', '--bare', join(root, 'origin.git'))
    git('init', '-b', 'main')
    git('config', 'user.name', 'Fixture')
    git('config', 'user.email', 'fixture@example.com')
    git('remote', 'add', 'origin', join(root, 'origin.git'))
    const packages = join(cwd, 'packages/ts-pantry/src/packages')
    await mkdir(join(packages, 'apps'), { recursive: true })
    const metadata = (domain: string, version: string) => `export default { domain: '${domain}', versions: ['${version}'] as const }\n`
    await writeFile(join(packages, 'curl.ts'), metadata('curl.se', '1.0.0'))
    await writeFile(join(packages, 'apps/desktop.ts'), metadata('desktop.example', '1.0.0'))
    git('add', '.')
    git('commit', '-m', 'fixture baseline')
    git('push', 'origin', 'main')
    await writeFile(join(packages, 'curl.ts'), metadata('curl.se', '1.0.1'))
    await writeFile(join(packages, 'apps/desktop.ts'), metadata('desktop.example', '1.0.1'))
    await writeFile(join(packages, 'new.ts'), metadata('new.example', '1.0.0'))
    await preparePublications(cwd, '123-1')
    const path = join(cwd, publicationDirectory, '123-1.json')
    expect(parsePublication(await readFile(path, 'utf8')).domains).toEqual(['curl.se', 'new.example'])
    git('add', '.')
    git('commit', '-m', 'catalog plus durable handoff')
    git('push', 'origin', 'main')
    const sha = git('rev-parse', 'HEAD')
    expect(await pendingPublications(cwd)).toEqual([{ id: '123-1', domains: ['curl.se', 'new.example'], sha }])
    await preparePublications(cwd, '124-1')
    expect(await pendingPublications(cwd)).toHaveLength(1)
    await preparePublications(cwd, '126-1', ['curl.se', 'curl.se'])
    expect(parsePublication(await readFile(join(cwd, publicationDirectory, '126-1.json'), 'utf8')).domains).toEqual(['curl.se'])
    await rm(join(cwd, publicationDirectory, '126-1.json'))
    await expect(preparePublications(cwd, '127-1', ['unknown.example'])).rejects.toThrow('No portable package metadata')
    git('push', 'origin', 'HEAD^:refs/tags/catalog-published/123-1')
    await expect(pendingPublications(cwd)).rejects.toThrow('different source commit')
    git('push', 'origin', '--delete', 'refs/tags/catalog-published/123-1')
    git('push', 'origin', `${sha}:refs/tags/catalog-published/123-1`)
    expect(await pendingPublications(cwd)).toEqual([])
    // A superseded request is retired the same way, and as strictly tied to its source.
    git('push', 'origin', '--delete', 'refs/tags/catalog-published/123-1')
    git('push', 'origin', 'HEAD^:refs/tags/catalog-superseded/123-1')
    await expect(pendingPublications(cwd)).rejects.toThrow('Superseded publication points to a different source commit')
    git('push', 'origin', '--delete', 'refs/tags/catalog-superseded/123-1')
    git('push', 'origin', `${sha}:refs/tags/catalog-superseded/123-1`)
    expect(await pendingPublications(cwd)).toEqual([])
    // What recovery itself records points at a blob naming the source, not at the commit: the
    // workflow token may not tag a commit whose workflow files differ from main's.
    git('push', 'origin', '--delete', 'refs/tags/catalog-superseded/123-1')
    expect(await pendingPublications(cwd)).toHaveLength(1)
    markPublication(cwd, 'superseded', '123-1', sha)
    const marker = git('ls-remote', 'origin', 'refs/tags/catalog-superseded/123-1').split(/\s+/)[0]!
    expect(marker).not.toBe(sha)
    expect(git('cat-file', '-t', marker)).toBe('blob')
    expect(git('cat-file', '-p', marker)).toBe(sha)
    expect(await pendingPublications(cwd)).toEqual([])
    git('push', 'origin', '--delete', 'refs/tags/catalog-superseded/123-1')
    // A marker for another source is as wrong as a tag on another commit.
    markPublication(cwd, 'published', '123-1', git('rev-parse', 'HEAD^'))
    await expect(pendingPublications(cwd)).rejects.toThrow('different source commit')
    git('push', 'origin', '--delete', 'refs/tags/catalog-published/123-1')
    markPublication(cwd, 'published', '123-1', sha)
    expect(await pendingPublications(cwd)).toEqual([])
    await preparePublications(cwd, '125-1')
    expect(await Bun.file(path).exists()).toBe(false)
    expect(git('status', '--porcelain')).toContain('D .github/catalog-publications/123-1.json')
  }
  finally { await rm(root, { recursive: true, force: true }) }
}, 15_000)

test('publication workflow pins every checkout and recovery trusts only main', async () => {
  const base = new URL('../../../.github/workflows/', import.meta.url)
  const publisher = Bun.YAML.parse(await readFile(new URL('publish-changed-packages.yml', base), 'utf8')) as any
  for (const job of Object.values(publisher.jobs) as any[]) {
    const checkout = job.steps.find((step: any) => step.uses?.startsWith('actions/checkout'))
    if (checkout) expect(checkout.with.ref).toBe('${{ inputs.source-sha || github.sha }}')
  }
  expect(publisher.jobs.detect.steps.find((step: any) => step.id === 'detect').run).toContain('--diff-filter=A')
  const recovery = Bun.YAML.parse(await readFile(new URL('recover-catalog-publications.yml', base), 'utf8')) as any
  expect(recovery.jobs.recover.steps[0].with.ref).toBe('main')
  expect(recovery.on.workflow_run.workflows.some((pattern: string) => new Bun.Glob(pattern).match(title))).toBe(true)
  expect(recovery.on.workflow_run.workflows.some((pattern: string) => new Bun.Glob(pattern).match(recovery.name))).toBe(false)
  expect(recovery.concurrency['cancel-in-progress']).toBe(false)
  const updater = Bun.YAML.parse(await readFile(new URL('update-packages.yml', base), 'utf8')) as any
  expect(updater.jobs['update-packages'].steps.find((step: any) => step.name === 'Prepare durable publication requests')).toBeDefined()
  expect(updater.jobs['update-packages'].steps.find((step: any) => step.name === 'Acknowledge processed releases').if).toContain("steps.land.outputs.landed == 'true'")
})


test('a busy repository cannot exhaust recovery by returning unrelated historical dispatches', async () => {
  const f = fixture()
  let requests = 0
  const api = async (path: string, init?: RequestInit) => {
    requests++
    if (!init && path.includes('/runs?')) {
      expect(path).toContain('created=%3E%3D2025-12-31T23%3A59%3A00.000Z')
      return { workflow_runs: [] }
    }
    return f.options.api(path, init)
  }
  expect(await recoverPublication(publication, { ...f.options, api })).toBe('dispatched')
  expect(requests).toBe(2)
})


test('partial publisher reruns retain prior successful platforms and use the latest job execution', async () => {
  const f = fixture([run])
  const api = async (path: string) => {
    if (!path.includes('/jobs?')) return { workflow_runs: [run] }
    expect(path).toContain('filter=all')
    return { total_count: 3, jobs: [
      { ...jobs[0], id: 3 }, { ...jobs[0], id: 1, conclusion: 'failure' }, { ...jobs[1], id: 2 },
    ] }
  }
  expect(await recoverPublication(publication, { ...f.options, api })).toBe('confirmed')
  expect(f.receipts).toEqual([[publication.id, publication.sha]])
})


test('the publisher explicitly wakes recovery and waits for its final parent verdict', async () => {
  let time = 0
  let reads = 0
  await waitForPublisherCompletion({ repository: 'pantry-pm/pantry', runId: '10', budgetMs: 20_000,
    now: () => time, sleep: async ms => { time += ms }, api: async () => ({
      ...run, status: ++reads === 1 ? 'in_progress' : 'completed',
    }),
  })
  expect(reads).toBe(2)
  const workflow = Bun.YAML.parse(await readFile(new URL('../../../.github/workflows/publish-changed-packages.yml', import.meta.url), 'utf8')) as any
  const callback = workflow.jobs['request-recovery']
  expect(callback.needs).toEqual(['detect', 'build', 'publish-darwin-native'])
  expect(callback.permissions.actions).toBe('write')
  expect(callback.steps[0].run).toContain('publisher-run="$GITHUB_RUN_ID"')
})

test('publisher callback rejects unrelated runs and retains work on finalization timeout', async () => {
  await expect(waitForPublisherCompletion({ repository: 'pantry-pm/pantry', runId: '10', api: async () => ({ ...run, path: '.github/workflows/ci.yml' }) })).rejects.toThrow('owning publication')
  let time = 0
  await expect(waitForPublisherCompletion({ repository: 'pantry-pm/pantry', runId: '10', budgetMs: 1,
    now: () => time, sleep: async ms => { time += ms }, api: async () => ({ ...run, status: 'in_progress' }),
  })).rejects.toThrow('wait budget')
})
