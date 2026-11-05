import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectPlatform, installPackage } from '../src/installer'

const scratch: string[] = []
afterEach(() => { for (const root of scratch.splice(0)) rmSync(root, { recursive: true, force: true }) })

test.skipIf(process.platform === 'win32')('recipe interfaces keep an older archive sourceable after cached installation and relocation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pantry-legacy-interface-'))
  scratch.push(root)
  const tree = join(root, 'pantry')
  const pkg = join(tree, 'gnu.org/gettext/v0.21.1')
  mkdirSync(join(pkg, 'bin'), { recursive: true })
  // Like the accepted older archive, this has no packaged interface manifest.
  writeFileSync(join(pkg, 'bin/gettext.sh'), '#!/bin/sh\nrecipe_fixture() { printf "source-ok\\n"; }\n', { mode: 0o755 })
  const sourced = (entry: string) => {
    const result = Bun.spawnSync(['sh', '-c', '. "$1"; recipe_fixture; printf "caller-alive\\n"', 'source-control', entry], { cwd: root })
    expect(result.exitCode, result.stderr.toString()).toBe(0)
    expect(result.stdout.toString()).toBe('source-ok\ncaller-alive\n')
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    await installPackage('gnu.org/gettext', '0.21.1', { installDir: tree, platform: detectPlatform(), globalBin: join(root, 'global'), quiet: true })
    sourced(join(tree, '.bin/gettext.sh'))
    sourced(join(root, 'global/gettext.sh'))
  }
  const moved = `${root} moved`
  renameSync(root, moved)
  scratch.push(moved)
  // The caller directory is unrelated to the moved package's own directory.
  const result = Bun.spawnSync(['sh', '-c', '. "$1"; recipe_fixture; printf "caller-alive\\n"', 'source-control', join(moved, 'pantry/.bin/gettext.sh')])
  expect(result.exitCode, result.stderr.toString()).toBe(0)
  expect(result.stdout.toString()).toBe('source-ok\ncaller-alive\n')
})

test.skipIf(process.platform === 'win32')('a matching shell filename in another provider still executes from its own package', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pantry-provider-interface-'))
  scratch.push(root)
  const tree = join(root, 'pantry')
  const pkg = join(tree, 'other.example/v1.0.0')
  mkdirSync(join(pkg, 'bin'), { recursive: true })
  mkdirSync(join(pkg, 'libexec'))
  writeFileSync(join(pkg, 'bin/gettext.sh'), '#!/bin/sh\nprefix=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd) || exit\nexec "$prefix/libexec/worker" "$@"\n', { mode: 0o755 })
  writeFileSync(join(pkg, 'libexec/worker'), '#!/bin/sh\nprintf "executed\\n"\n', { mode: 0o755 })
  await installPackage('other.example', '1.0.0', { installDir: tree, platform: detectPlatform(), quiet: true })
  const result = Bun.spawnSync([join(tree, '.bin/gettext.sh')])
  expect(result.exitCode, result.stderr.toString()).toBe(0)
  expect(result.stdout.toString()).toBe('executed\n')
})

test.skipIf(process.platform === 'win32')('a packaged interface overrides the recipe and malformed interfaces leave working entries intact', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pantry-packaged-interface-'))
  scratch.push(root)
  const tree = join(root, 'pantry')
  const pkg = join(tree, 'gnu.org/gettext/v0.21.1')
  mkdirSync(join(pkg, 'bin'), { recursive: true })
  mkdirSync(join(pkg, 'libexec'))
  mkdirSync(join(pkg, 'share/pantry'), { recursive: true })
  writeFileSync(join(pkg, 'bin/gettext.sh'), '#!/bin/sh\nprefix=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd) || exit\nexec "$prefix/libexec/worker"\n', { mode: 0o755 })
  writeFileSync(join(pkg, 'libexec/worker'), '#!/bin/sh\nprintf "packaged-contract\\n"\n', { mode: 0o755 })
  const manifest = join(pkg, 'share/pantry/interfaces.json')
  writeFileSync(manifest, JSON.stringify({ version: 1, sourceablePrograms: [] }))
  const options = { installDir: tree, platform: detectPlatform(), globalBin: join(root, 'global'), quiet: true }
  await installPackage('gnu.org/gettext', '0.21.1', options)
  const entries = [join(tree, '.bin/gettext.sh'), join(root, 'global/gettext.sh')]
  const before = entries.map(entry => readFileSync(entry))
  for (const entry of entries) {
    const result = Bun.spawnSync([entry])
    expect(result.exitCode, result.stderr.toString()).toBe(0)
    expect(result.stdout.toString()).toBe('packaged-contract\n')
  }
  writeFileSync(manifest, '{invalid')
  await expect(installPackage('gnu.org/gettext', '0.21.1', options)).rejects.toThrow()
  expect(entries.map(entry => readFileSync(entry))).toEqual(before)
})
