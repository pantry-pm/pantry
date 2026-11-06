import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { parsePublication, pendingPublications, preparePublications, publicationDirectory, recoverPublication } from '../../../.github/scripts/catalog-publications'

const publication = { id: '123-1', sha: 'a'.repeat(40), domains: ['curl.se'] }
const title = `catalog:${publication.id}:${publication.sha}:all:false`
const run = { id: 10, display_title: title, event: 'workflow_dispatch', path: '.github/workflows/publish-changed-packages.yml',
  status: 'completed', conclusion: 'success', updated_at: '2026-01-01T00:00:00Z', head_repository: { full_name: 'pantry-pm/pantry' } }
const jobs = ['linux-x86-64', 'linux-arm64'].map(platform => ({ name: `Publish (${platform})`, conclusion: 'success',
  steps: [{ name: 'Publish changed packages (download-first)', conclusion: 'success' }] }))

function fixture(runs: typeof run[] = []) {
  const calls: Array<{ path: string, init?: RequestInit }> = []
  const receipts: string[][] = []
  return { calls, receipts, options: { repository: 'pantry-pm/pantry', now: () => Date.parse('2026-01-01T02:00:00Z'),
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
    expect(checkout.with.ref).toBe('${{ inputs.source-sha || github.sha }}')
  }
  expect(publisher.jobs.detect.steps.find((step: any) => step.id === 'detect').run).toContain('--diff-filter=A')
  const recovery = Bun.YAML.parse(await readFile(new URL('recover-catalog-publications.yml', base), 'utf8')) as any
  expect(recovery.jobs.recover.steps[0].with.ref).toBe('main')
  expect(recovery.concurrency['cancel-in-progress']).toBe(false)
  const updater = Bun.YAML.parse(await readFile(new URL('update-packages.yml', base), 'utf8')) as any
  expect(updater.jobs['update-packages'].steps.find((step: any) => step.name === 'Prepare durable publication requests')).toBeDefined()
  expect(updater.jobs['update-packages'].steps.find((step: any) => step.name === 'Acknowledge processed releases').if).toContain("steps.land.outputs.landed == 'true'")
})
