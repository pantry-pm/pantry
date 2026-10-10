import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { changedPackageDomains } from '../scripts/changed-package-domains'

test('recipe asset edits and deletions rebuild the owning domain', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pantry-recipe-assets-'))
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(['git', ...args], { cwd: directory, env: { ...process.env, GIT_AUTHOR_NAME: 'Chris', GIT_AUTHOR_EMAIL: 'chris@stacksjs.com', GIT_COMMITTER_NAME: 'Chris', GIT_COMMITTER_EMAIL: 'chris@stacksjs.com' }, stdout: 'pipe', stderr: 'pipe' })
    if (result.exitCode) throw new Error(result.stderr.toString())
    return result.stdout.toString().trim()
  }
  const write = (path: string, body: string) => { const full = join(directory, path); mkdirSync(dirname(full), { recursive: true }); writeFileSync(full, body) }
  const root = 'packages/ts-pantry/src/recipes/'
  try {
    git('init', '-q')
    for (const domain of ['git-scm.org', 'github.com/example/tool']) {
      write(`${root}${domain}.ts`, `export const recipe = { domain: '${domain}' }\n`)
      write(`${root}props/${domain}/config`, 'original\n')
    }
    git('add', '-f', '.')
    git('commit', '-qm', 'fixture: initial recipes')
    const before = git('rev-parse', 'HEAD')
    write(`${root}props/git-scm.org/config`, 'fixed\n')
    rmSync(join(directory, `${root}props/github.com/example/tool/config`))
    git('add', '-A')
    git('commit', '-qm', 'fixture: recipe assets changed')
    expect(git('diff', '--name-only', before, 'HEAD')).toContain('props/github.com/example/tool/config')
    expect(changedPackageDomains(before, 'HEAD', directory)).toEqual(['git-scm.org', 'github.com/example/tool'])
  }
  finally { rmSync(directory, { recursive: true, force: true }) }
})
