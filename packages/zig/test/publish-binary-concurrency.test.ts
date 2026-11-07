import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const binary = process.env.PANTRY_E2E_BIN || resolve(import.meta.dir, '../zig-out/bin/pantry')
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

for (const { platforms, reject } of [
  { platforms: ['darwin-arm64', 'linux-x86-64'], reject: false },
  { platforms: ['darwin-arm64', 'darwin-arm64'], reject: false },
  { platforms: ['darwin-arm64', 'darwin-arm64'], reject: true },
]) {
  test(`${reject ? 'rejected' : 'overlapping'} binary publications own their exact archives (${platforms.join(', ')})`, async () => {
    expect(existsSync(binary)).toBe(true)
    const directory = await mkdtemp(join(tmpdir(), 'pantry-publish-overlap-'))
    const requests: Array<{ sha256: string, size: number, platforms: string[], filename: string }> = []
    const uploaded = new Map<string, Uint8Array>()
    const children: ReturnType<typeof Bun.spawn>[] = []
    const firstSeen = Promise.withResolvers<void>()
    const bothInitiated = Promise.withResolvers<void>()
    const bothUploaded = Promise.withResolvers<void>()
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname
        if (path === '/api/v1/binaries/uploads') {
          const metadata = await request.json() as typeof requests[number]
          const id = String(requests.push(metadata))
          firstSeen.resolve()
          if (reject) return new Response('rejected test upload', { status: 400 })
          if (requests.length === 2) bothInitiated.resolve()
          await bothInitiated.promise
          return Response.json({ uploadId: id, uploadUrl: `http://127.0.0.1:${server.port}/upload/${id}` })
        }
        if (path.startsWith('/upload/')) {
          uploaded.set(path.split('/').at(-1)!, new Uint8Array(await request.arrayBuffer()))
          if (uploaded.size === 2) bothUploaded.resolve()
          return new Response(null, { status: 204 })
        }
        if (path === '/api/v1/binaries/uploads/complete') {
          await bothUploaded.promise
          return Response.json({ success: true })
        }
        return new Response(null, { status: 404 })
      },
    })
    let passed = false
    try {
      const scratch = join(directory, 'scratch')
      await mkdir(scratch)
      const domain = 'publication-overlap.example'
      const version = '1.0.0'
      const sentinel = join(scratch, `${domain}-${version}.tar.gz`)
      await writeFile(sentinel, 'pre-existing unrelated archive')
      const paths = await Promise.all(['first', 'second'].map(async name => {
        const parent = join(directory, name)
        await mkdir(parent)
        const path = join(parent, 'tool')
        await writeFile(path, `#!/bin/sh\nprintf '${name} exact bytes\\n'\n`)
        return path
      }))
      const launch = (index: number) => {
        const child = Bun.spawn([binary, 'publish:binary', '--domain', domain, '--version', version, '--binary', paths[index]!, '--platform', platforms[index]!], {
          env: { ...process.env, TMPDIR: scratch, PANTRY_REGISTRY_URL: `http://127.0.0.1:${server.port}`, PANTRY_REGISTRY_TOKEN: 'ptry_local_overlap_test' },
          stdout: 'pipe', stderr: 'pipe', timeout: 4000,
        })
        children.push(child)
        return Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      }
      const first = launch(0)
      await firstSeen.promise
      const second = launch(1)
      const results = await Promise.all([first, second])
      await writeFile(join(directory, 'receipt.json'), JSON.stringify({ requests, results, uploads: [...uploaded].map(([id, bytes]) => ({ id, sha256: digest(bytes), size: bytes.length })) }, null, 2))
      for (const [id, bytes] of uploaded) await writeFile(join(directory, `uploaded-${id}.tar.gz`), bytes)
      expect(requests).toHaveLength(2)
      for (const [code, stdout, stderr] of results) {
        if (reject) {
          expect(code, `${stdout}\n${stderr}`).not.toBe(0)
          expect(`${stdout}\n${stderr}`).toContain('Registry rejected binary staging request')
        }
        else expect(code, `${stdout}\n${stderr}`).toBe(0)
      }
      expect(uploaded.size).toBe(reject ? 0 : 2)
      if (!reject) {
        for (const [index, metadata] of requests.entries()) {
          const bytes = uploaded.get(String(index + 1))!
          expect(digest(bytes), `publication ${index + 1} must upload its own hashed bytes`).toBe(metadata.sha256)
          expect(bytes.length).toBe(metadata.size)
        }
        expect(requests[0]!.sha256).not.toBe(requests[1]!.sha256)
      }
      expect(await readFile(sentinel, 'utf8')).toBe('pre-existing unrelated archive')
      expect(await readdir(scratch)).toEqual([`${domain}-${version}.tar.gz`])
      passed = true
    }
    finally {
      for (const child of children) if (child.exitCode === null) child.kill()
      await Promise.allSettled(children.map(child => child.exited))
      await server.stop(true)
      if (passed || !process.env.PANTRY_PUBLISH_KEEP_FAILURES) await rm(directory, { recursive: true, force: true })
      else console.error(`Retained failed publication evidence: ${directory}`)
    }
  })
}
