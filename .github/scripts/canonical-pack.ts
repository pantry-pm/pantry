import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { archiveMember, archiveMembers } from './published-archive'

assert(process.env.PANTRY_SOURCE_CLI, 'Supply the real source CLI')
const cli = resolve(process.env.PANTRY_SOURCE_CLI)
const evidence = resolve(process.env.PANTRY_PACK_EVIDENCE ?? 'artifacts/canonical-pack')
await mkdir(evidence, { recursive: true })
const root = await mkdtemp(join(tmpdir(), 'pantry canonical pack '))
const owner = join(root, 'packages/owner')
const sibling = join(root, 'packages/sibling')
const output = join(evidence, 'canonical.tgz')
const commands: Array<Record<string, unknown>> = []
const receipt: Record<string, unknown> = { passed: false, cli, cliSha256: Bun.SHA256.hash(await readFile(cli), 'hex'), root, commands }
const env = { ...process.env, HOME: join(root, 'home'), XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache'), PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`, NPM_TOKEN: '', NODE_AUTH_TOKEN: '', BUN_AUTH_TOKEN: '', PANTRY_TOKEN: '' }

async function pack(args: string[] = [], extra: Record<string, string> = {}) {
  const child = Bun.spawn([cli, 'pack', owner, '--filename', output, ...args], { cwd: root, env: { ...env, ...extra }, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore', timeout: 30_000 })
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  commands.push({ args, code, signal: child.signalCode ?? null, stdout, stderr })
  assert(!/error\(DebugAllocator\)|memory address .* leaked/i.test(stderr), stderr)
  assert.equal(child.signalCode ?? null, null, stderr)
  assert(!child.exitedDueToTimeout)
  return { code, output: stdout + stderr }
}

try {
  await mkdir(join(owner, 'dist'), { recursive: true })
  await mkdir(join(owner, 'assets'), { recursive: true })
  await mkdir(sibling)
  await mkdir(env.HOME)
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'canonical-fixture-root', private: true, workspaces: ['packages/*'] }))
  await writeFile(join(root, 'LICENSE.md'), 'root license bytes\n')
  await writeFile(join(root, 'README.md'), 'root readme bytes\n')
  await writeFile(join(sibling, 'package.json'), JSON.stringify({ name: '@fixture/sibling', version: '2.4.0' }))
  const manifest = { name: '@fixture/canonical', version: '1.0.0', files: ['dist', 'assets'], main: './dist/index.js', bin: { 'fixture-cli': './dist/cli' }, dependencies: { '@fixture/sibling': 'workspace:^' } }
  const manifestBytes = JSON.stringify(manifest)
  await writeFile(join(owner, 'package.json'), manifestBytes)
  await writeFile(join(owner, 'README.md'), 'package readme wins\n')
  await writeFile(join(owner, 'dist/index.js'), 'export const value = "qualified"\n')
  await writeFile(join(owner, 'dist/cli'), '#!/bin/sh\nprintf qualified\n')
  await writeFile(join(owner, 'assets/helper.sh'), '#!/bin/sh\nprintf helper\n')
  await writeFile(join(owner, 'assets/.gitignore'), 'template-ignore\n')
  await writeFile(join(owner, 'assets/data.txt'), 'ordinary data\n')
  await writeFile(join(owner, 'excluded.txt'), 'not in the manifest file list\n')
  await chmod(join(owner, 'dist/cli'), 0o644)
  await chmod(join(owner, 'assets/helper.sh'), 0o755)
  await chmod(join(owner, 'assets/data.txt'), 0o640)
  if (process.platform !== 'win32') await symlink('data.txt', join(owner, 'assets/data-link'))

  const result = await pack(['--ignore-scripts'])
  assert.equal(result.code, 0, result.output)
  const archive = await readFile(output)
  await writeFile(join(evidence, 'pack-before-hooks.tgz'), archive)
  receipt.archiveSha256 = Bun.SHA256.hash(archive, 'hex')
  const files = await new Bun.Archive(archive).files()
  assert.equal(await files.get('package/LICENSE.md')?.text(), 'root license bytes\n')
  assert.equal(await files.get('package/README.md')?.text(), 'package readme wins\n')
  assert.equal(await files.get('package/assets/.gitignore')?.text(), 'template-ignore\n')
  assert(!files.has('package/excluded.txt'))
  assert.equal((await files.get('package/package.json')!.json()).dependencies['@fixture/sibling'], '^2.4.0')
  assert.equal(archiveMember(archive, 'package/dist/cli')?.mode, 0o755)
  if (process.platform !== 'win32') {
    assert.equal(archiveMember(archive, 'package/assets/helper.sh')?.mode, 0o755)
    assert.equal(archiveMember(archive, 'package/assets/data.txt')?.mode, 0o640)
    assert.equal(archiveMember(archive, 'package/assets/data-link')?.link, 'data.txt')
    assert.equal((await stat(join(owner, 'dist/cli'))).mode & 0o777, 0o644)
  }
  assert.equal(await readFile(join(owner, 'package.json'), 'utf8'), manifestBytes)
  assert(!await Bun.file(join(owner, 'LICENSE.md')).exists(), 'Inherited documentation must be staged without mutating source')

  // Compare the ordinary batch publisher's actual upload with pack's snapshot.
  // This is the public provider seam; neither archive is rewritten for the test.
  let uploads = 0, metadataReads = 0, tarballReads = 0
  let uploaded = Buffer.alloc(0)
  let metadata: Record<string, unknown> = {}
  let serverError: unknown
  const registry = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(request) {
      try {
        const path = decodeURIComponent(new URL(request.url).pathname)
        if (request.method === 'PUT' && path === `/${manifest.name}`) {
          uploads++
          assert(!await Bun.file(join(owner, 'LICENSE.md')).exists(), 'Publisher temporarily mutated the source package')
          const body = await request.json() as { versions: Record<string, Record<string, unknown>>, _attachments: Record<string, { data: string }> }
          uploaded = Buffer.from(Object.values(body._attachments)[0]!.data, 'base64')
          metadata = { ...body.versions[manifest.version], dist: {
            tarball: `${registry.url}fixture.tgz`,
            integrity: `sha512-${createHash('sha512').update(uploaded).digest('base64')}`,
          } }
          return Response.json({ success: true }, { status: 201 })
        }
        if (request.method === 'GET' && path === `/${manifest.name}/${manifest.version}`) {
          metadataReads++
          return uploads ? Response.json(metadata) : Response.json({ error: 'not found' }, { status: 404 })
        }
        if (request.method === 'GET' && path === '/fixture.tgz') {
          tarballReads++
          return new Response(uploaded)
        }
        return new Response('Unexpected fixture request', { status: 400 })
      }
      catch (error) {
        serverError = error
        return new Response('Publication fixture assertion failed', { status: 400 })
      }
    },
  })
  try {
    const args = ['publish', '--npm', 'packages/owner', '--ignore-scripts', '--no-oidc', '--access', 'public', '--registry', registry.url.origin]
    const child = Bun.spawn([cli, ...args], { cwd: root, env: { ...env, NPM_TOKEN: 'disposable-loopback-fixture-only' }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 30_000 })
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    commands.push({ args, code, signal: child.signalCode ?? null, stdout, stderr })
    assert.equal(child.signalCode ?? null, null, stderr)
    assert(!child.exitedDueToTimeout)
    assert(!/error\(DebugAllocator\)/.test(stderr), stderr)
    assert.equal(serverError, undefined)
    assert.equal(code, 0, stdout + stderr)
    assert.equal(uploads, 1)
    await writeFile(join(evidence, 'uploaded.tgz'), uploaded)
    assert(metadataReads > 0 && tarballReads > 0, 'Publisher did not verify its uploaded archive')
    const packedMembers = archiveMembers(archive)
    const publishedMembers = archiveMembers(uploaded)
    assert.deepEqual([...publishedMembers.keys()].sort(), [...packedMembers.keys()].sort(), 'Publisher and pack chose different members')
    for (const [path, member] of packedMembers)
      assert.deepEqual(publishedMembers.get(path), member, path)
    assert(!await Bun.file(join(owner, 'LICENSE.md')).exists())
    assert.equal(await readFile(join(owner, 'package.json'), 'utf8'), manifestBytes)
    receipt.publicationParity = { uploads, metadataReads, tarballReads, members: packedMembers.size, passed: true }
  }
  finally {
    await registry.stop(true)
  }

  const hooks = { ...manifest, scripts: Object.fromEntries(['prepack', 'prepare', 'postpack', 'prepublishOnly', 'publish'].map(event => [event, `bun hook.ts ${event}`])) }
  await writeFile(join(owner, 'package.json'), JSON.stringify(hooks))
  await writeFile(join(owner, 'hook.ts'), `import { appendFile } from 'node:fs/promises'
const event = process.argv[2]!
await appendFile('events.log', event + '\\n')
if (process.env.PANTRY_PACK_HOOK_FAIL === event) process.exit(9)
if (event === 'prepare') await Bun.write('dist/index.js', 'export const value = "prepared"\\n')
if (event === 'postpack') await Bun.write('assets/late.txt', 'after archive creation\\n')
`)
  const ignored = await pack(['--ignore-scripts'])
  assert.equal(ignored.code, 0, ignored.output)
  assert(!await Bun.file(join(owner, 'events.log')).exists())
  const normal = await pack()
  assert.equal(normal.code, 0, normal.output)
  assert.equal(await readFile(join(owner, 'events.log'), 'utf8'), 'prepack\nprepare\npostpack\n')
  const completed = await readFile(output)
  const prepared = await new Bun.Archive(completed).files()
  assert.equal(await prepared.get('package/dist/index.js')?.text(), 'export const value = "prepared"\n')
  assert(!prepared.has('package/assets/late.txt'), 'postpack runs after the snapshot is packed')
  for (const event of ['prepack', 'prepare', 'postpack']) {
    const failed = await pack([], { PANTRY_PACK_HOOK_FAIL: event })
    assert.notEqual(failed.code, 0, failed.output)
    assert.deepEqual(await readFile(output), completed, `${event} failure replaced the previous qualified archive`)
  }
  await writeFile(join(root, 'outside.txt'), 'outside package bytes\n')
  await writeFile(join(owner, 'package.json'), JSON.stringify({ ...manifest, files: ['../../outside.txt'] }))
  const escaped = await pack(['--ignore-scripts'])
  assert.notEqual(escaped.code, 0, escaped.output)
  assert(escaped.output.includes('Error: Could not create package archive: TarballCreationFailed'), escaped.output)
  assert.deepEqual(await readFile(output), completed, 'Invalid package entry replaced the previous qualified archive')
  assert.equal(await readFile(join(root, 'outside.txt'), 'utf8'), 'outside package bytes\n')

  await writeFile(join(owner, 'package.json'), JSON.stringify({ ...manifest, files: undefined }))
  await writeFile(join(owner, '.npmignore'), 'LICENSE.md\nexcluded.txt\nhook.ts\nevents.log\n')
  await writeFile(join(owner, '.env'), 'PRIVATE_FIXTURE=not-shipped\n')
  const filtered = await pack(['--ignore-scripts'])
  assert.equal(filtered.code, 0, filtered.output)
  const filteredFiles = await new Bun.Archive(await readFile(output)).files()
  for (const path of ['package/LICENSE.md', 'package/excluded.txt', 'package/.env', 'package/hook.ts'])
    assert(!filteredFiles.has(path), `Canonical ignore rules lost for ${path}`)
  receipt.passed = true
}
finally {
  await rm(root, { recursive: true, force: true })
  receipt.cleaned = true
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
}
