import { afterEach, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('./generate-update-commit-message.ts', import.meta.url))
const packageRoot = 'packages/ts-pantry/src/packages/'
const zigPath = 'packages/zig/src/packages/generated.zig'
const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'pantry-update-message-'))
  directories.push(directory)
  const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
    cwd: directory,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
  const write = (path: string, content: string) => {
    const fullPath = join(directory, path)
    mkdirSync(dirname(fullPath), { recursive: true })
    writeFileSync(fullPath, content)
  }
  const commit = () => {
    git('add', '.')
    git('commit', '-qm', 'fixture')
    return git('rev-parse', 'HEAD')
  }
  const run = (...args: string[]) => {
    const output = execFileSync(process.execPath, [script, '--message-file', join(directory, 'message.txt'), ...args], {
      cwd: directory,
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_OUTPUT: join(directory, 'github-output.txt'),
        GITHUB_SERVER_URL: 'https://github.com',
        GITHUB_REPOSITORY: 'pantry-pm/pantry',
        GITHUB_RUN_ID: '123',
        GITHUB_WORKFLOW: 'Update Packages',
      },
    })
    expect(readFileSync(join(directory, 'message.txt'), 'utf8')).toBe(output)
    return output
  }
  git('init', '-q')
  git('config', 'user.name', 'Pantry Test')
  git('config', 'user.email', 'test@example.com')
  write('README.md', 'Fixture\n')
  commit()
  return { directory, git, write, commit, run }
}

function tsPackage(name: string, domain: string, version: string): string {
  return `export const pkg = {
  name: '${name}' as const,
  domain: '${domain}' as const,
  versions: ['${version}'] as const,
}\n`
}

function zigPackages(packages: Array<[string, string, string]>): string {
  return `pub const packages = [_]PackageInfo{ .{\n${packages.map(([name, domain, version]) =>
    `    .name = "${name}",\n    .domain = "${domain}",\n    .versions = &[_][]const u8{ "${version}" },`,
  ).join('\n}, .{\n')}\n} };\n`
}

test('single update uses the product name and retains its domain and version transition in the body', () => {
  const f = fixture()
  const path = `${packageRoot}craft.ts`
  f.write(path, tsPackage('craft', 'craft-native.org', '0.0.345'))
  f.commit()
  f.write(path, tsPackage('craft', 'craft-native.org', '0.0.346'))

  const output = f.run()
  expect(output).toStartWith('chore: update craft to 0.0.346\n')
  expect(output).toContain('- craft (craft-native.org): 0.0.345 -> 0.0.346')
  expect(output).toContain('Triggered by: https://github.com/pantry-pm/pantry/actions/runs/123')
  expect(readFileSync(join(f.directory, 'github-output.txt'), 'utf8')).toContain('commit_message=chore: update craft to 0.0.346\n')
})

test('multiple updates are sorted by product name and catalog copies do not duplicate them', () => {
  const f = fixture()
  f.write(`${packageRoot}a.ts`, tsPackage('vim', 'a.example', '1'))
  f.write(`${packageRoot}z.ts`, tsPackage('dotnet', 'z.example', '1'))
  f.write(zigPath, zigPackages([['vim', 'a.example', '1'], ['dotnet', 'z.example', '1']]))
  f.commit()
  f.write(`${packageRoot}a.ts`, tsPackage('vim', 'a.example', '2'))
  f.write(`${packageRoot}z.ts`, tsPackage('dotnet', 'z.example', '2'))
  f.write(zigPath, zigPackages([['vim', 'a.example', '2'], ['dotnet', 'z.example', '2']]))

  const output = f.run()
  expect(output).toStartWith('chore: update dotnet, vim\n')
  expect(output.match(/^- /gm)).toHaveLength(2)
})

test('catalog-only updates include product names and newly added packages', () => {
  const f = fixture()
  f.write(zigPath, zigPackages([['dotnet', 'dotnet.microsoft.com', '9']]))
  f.commit()
  f.write(zigPath, zigPackages([['dotnet', 'dotnet.microsoft.com', '10'], ['craft', 'craft-native.org', '1']]))

  const output = f.run()
  expect(output).toStartWith('chore: update craft, dotnet\n')
  expect(output).toContain('- craft (craft-native.org): new -> 1')
  expect(output).toContain('- dotnet (dotnet.microsoft.com): 9 -> 10')
})

test('worktree comparison honors a custom base even when all updates are already committed', () => {
  const f = fixture()
  const path = `${packageRoot}craft.ts`
  f.write(path, tsPackage('craft', 'craft-native.org', '1'))
  const base = f.commit()
  f.write(path, tsPackage('craft', 'craft-native.org', '2'))
  const head = f.commit()

  expect(f.run('--base', base)).toStartWith('chore: update craft to 2\n')
  f.write(path, tsPackage('craft', 'craft-native.org', '3'))
  expect(f.run('--base', base, '--head', head)).toStartWith('chore: update craft to 2\n')
})

test('staged renames and literal filenames with spaces, quotes and shell syntax are handled safely', () => {
  const f = fixture()
  const oldPath = `${packageRoot}old.ts`
  const newPath = `${packageRoot}craft $(touch injected) "quoted".ts`
  f.write(oldPath, tsPackage('craft', 'craft-native.org', '1'))
  f.commit()
  f.git('mv', oldPath, newPath)
  f.write(newPath, tsPackage('craft', 'craft-native.org', '2'))
  f.git('add', newPath)
  const base = f.git('rev-parse', 'HEAD')

  expect(f.run()).toStartWith('chore: update craft to 2\n')
  const head = f.commit()
  expect(f.run('--base', base, '--head', head)).toStartWith('chore: update craft to 2\n')
  expect(existsSync(join(f.directory, 'injected'))).toBe(false)
})

test('untracked metadata is included and a blank product name falls back to the domain', () => {
  const f = fixture()
  f.write(`${packageRoot}new.ts`, tsPackage('   ', 'new.example', '1'))

  const output = f.run()
  expect(output).toStartWith('chore: update new.example to 1\n')
  expect(output).toContain('- new.example: new -> 1')
})

test('non-version edits, deleted metadata and generated indexes do not invent version updates', () => {
  const f = fixture()
  const path = `${packageRoot}craft.ts`
  const removed = `${packageRoot}removed.ts`
  f.write(path, tsPackage('craft', 'craft-native.org', '1'))
  f.write(removed, tsPackage('removed', 'removed.example', '1'))
  f.commit()
  f.write(path, `${tsPackage('craft', 'craft-native.org', '1')}\n// Refreshed description\n`)
  f.write(`${packageRoot}index.ts`, tsPackage('ignored', 'ignored.example', '2'))
  rmSync(join(f.directory, removed))

  const output = f.run()
  expect(output).toStartWith('chore: update package metadata\n')
  expect(output).toContain('Refreshed generated package metadata.')
})
