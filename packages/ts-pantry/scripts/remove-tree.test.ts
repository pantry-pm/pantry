import { expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeTree } from './remove-tree'

test('removes a build tree holding a read-only Go module cache', () => {
  const root = mkdtempSync(join(tmpdir(), 'pantry-remove-tree-'))
  const build = join(root, 'buildkit-casdoor.org')
  const cached = join(build, '.home/go/pkg/mod/github.com/example@v1.0.0')
  try {
    mkdirSync(join(build, 'object'), { recursive: true })
    writeFileSync(join(build, 'object/edition_types.go'), 'package object\n')
    mkdirSync(cached, { recursive: true })
    for (let i = 0; i < 50; i++) writeFileSync(join(cached, `f${i}.go`), 'package example\n')
    chmodSync(cached, 0o555)
    chmodSync(join(cached, '..'), 0o555)
    removeTree(build)
    expect(existsSync(build)).toBe(false)
  }
  finally {
    if (existsSync(cached)) { chmodSync(join(cached, '..'), 0o755); chmodSync(cached, 0o755) }
    rmSync(root, { recursive: true, force: true })
  }
})

test('a missing tree is already removed', () => {
  expect(() => removeTree(join(tmpdir(), 'pantry-remove-tree-missing-dir'))).not.toThrow()
})
