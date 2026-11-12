import { expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { dependencyCachePaths } from './dependency-cache-paths'
import * as glob from '@actions/glob'

test.skipIf(process.platform === 'win32')('a native package cache restores its payload without replacing a selected Git build input or command', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pantry-cache-ownership-'))
  const pantry = join(root, 'pantry')
  const source = join(pantry, 'zig-config')
  const native = join(pantry, 'gnu.org/tar/v1.35.0')
  const bin = join(pantry, '.bin')
  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'Chris Breuer', GIT_AUTHOR_EMAIL: 'chris@stacksjs.com', GIT_COMMITTER_NAME: 'Chris Breuer', GIT_COMMITTER_EMAIL: 'chris@stacksjs.com' }
  const run = (args: string[], cwd = root) => {
    const result = Bun.spawnSync(args, { cwd, env: gitEnv, stdout: 'pipe', stderr: 'pipe', timeout: 10000 })
    expect(result.signalCode ?? null).toBeNull()
    expect(result.exitCode, result.stderr.toString()).toBe(0)
    return result.stdout.toString().trim()
  }
  const git = (...args: string[]) => run(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-C', source, ...args])
  try {
    mkdirSync(source, { recursive: true })
    mkdirSync(join(native, 'bin'), { recursive: true })
    mkdirSync(bin)
    git('init', '--quiet', '-b', 'trunk')
    writeFileSync(join(source, 'build.zig'), 'declared Git build input\n')
    git('add', '.')
    git('commit', '--quiet', '-m', 'test: declare compiler input')
    const wanted = git('rev-parse', 'HEAD')
    writeFileSync(join(source, 'build.zig'), 'unrequested default branch\n')
    git('commit', '--quiet', '-am', 'test: advance default branch')
    writeFileSync(join(native, 'bin/tar'), 'verified native payload\n')
    chmodSync(join(native, 'bin/tar'), 0o755)
    writeFileSync(join(bin, 'selected'), 'stale command selection\n')
    const paths = dependencyCachePaths(pantry, [{ domain: 'gnu.org/tar', version: '1.35.0' }])
    const archive = join(root, 'native-cache.tar.gz')
    const selected = await (await glob.create(paths.join('\n'), { implicitDescendants: false, followSymbolicLinks: false })).glob()
    expect(selected.length).toBeGreaterThan(0)
    run(['tar', '-czf', archive, '-C', pantry, '--', ...selected.map(path => relative(pantry, path) || '.')])

    git('checkout', '--quiet', '--detach', wanted)
    writeFileSync(join(bin, 'selected'), 'current command selection\n')
    rmSync(native, { recursive: true })
    run(['tar', '-xzf', archive, '-C', pantry])

    expect(git('rev-parse', 'HEAD')).toBe(wanted)
    expect(readFileSync(join(source, 'build.zig'), 'utf8')).toBe('declared Git build input\n')
    expect(readFileSync(join(bin, 'selected'), 'utf8')).toBe('current command selection\n')
    expect(readFileSync(join(native, 'bin/tar'), 'utf8')).toBe('verified native payload\n')
    expect(statSync(join(native, 'bin/tar')).mode & 0o777).toBe(0o755)

    const fresh = join(root, 'fresh')
    mkdirSync(fresh)
    run(['tar', '-xzf', archive, '-C', fresh])
    expect(readFileSync(join(fresh, 'gnu.org/tar/v1.35.0/bin/tar'), 'utf8')).toBe('verified native payload\n')
    expect(existsSync(join(fresh, 'zig-config'))).toBe(false)
    expect(existsSync(join(fresh, '.bin'))).toBe(false)
  }
  finally { rmSync(root, { recursive: true, force: true }) }
})

test('native cache paths bound nested domains and SDK runtime versions without owning workspace roots', () => {
  const root = join(tmpdir(), 'pantry-cache-path-contract')
  expect(dependencyCachePaths(root, [
    { domain: 'gnu.org/gcc/libstdcxx', version: '14.3.0' },
    { domain: 'bun.com' },
    { domain: 'bun.com' },
  ])).toEqual([join(root, 'bun.com/v*'), join(root, 'gnu.org/gcc/libstdcxx/v14.3.0')].sort())
  expect(dependencyCachePaths(root, [])).toEqual([])
  for (const domain of ['', '../source', '/outside', 'gnu.org/../source', 'gnu.org/*', 'C:\\source', 'gnu.org/', `gnu.org${String.fromCharCode(10)}`])
    expect(() => dependencyCachePaths(root, [{ domain }])).toThrow('Invalid native cache domain')
  for (const version of ['', '../source', '1.0/../../source', '*', '1.0\n', `1.0${String.fromCharCode(10)}`])
    expect(() => dependencyCachePaths(root, [{ domain: 'gnu.org/tar', version }])).toThrow('Invalid native cache version')
})
