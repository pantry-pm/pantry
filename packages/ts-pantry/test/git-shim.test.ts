import { expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('Git shim resolves aliases through its native binary without calling itself through PATH', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pantry-git-shim-'))
  try {
    for (const name of ['bin', 'libexec', 'trap']) mkdirSync(join(directory, name))
    const shim = join(directory, 'bin/git')
    writeFileSync(shim, readFileSync(join(import.meta.dir, '../src/recipes/props/git-scm.org/git-shim')))
    writeFileSync(join(directory, 'libexec/git'), '#!/bin/sh\nif [ "$1" = config ]; then echo alias.saved; else printf "%s\\n" "$*"; fi\n')
    // A PATH Git stands in for the installed shim, but fails instead of forking
    // recursively. Alias discovery must call libexec/git directly.
    writeFileSync(join(directory, 'trap/git'), '#!/bin/sh\necho recursive-git-wrapper >&2\nexit 1\n')
    for (const path of [shim, join(directory, 'libexec/git'), join(directory, 'trap/git')]) chmodSync(path, 0o755)
    for (const command of ['status', 'saved', 'config']) {
      const child = Bun.spawn([shim, command], { env: { ...process.env, PATH: `${join(directory, 'trap')}:/usr/bin:/bin` }, stdout: 'pipe', stderr: 'pipe' })
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      expect(code).toBe(0)
      expect(stderr).toBe('')
      expect(stdout.trim()).toBe(command === 'config' ? 'alias.saved' : command)
    }
  }
  finally { rmSync(directory, { recursive: true, force: true }) }
})
