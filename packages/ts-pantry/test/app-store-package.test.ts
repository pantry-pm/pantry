import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ownerOnlyFiles } from '../src/native/apple'

describe('ownerOnlyFiles', () => {
  // App Store Connect rejects such a package (90255) only after an upload attempt.
  test('names files and folders other users cannot read', () => {
    const app = mkdtempSync(join(tmpdir(), 'pantry-perms-'))
    try {
      chmodSync(app, 0o755)
      mkdirSync(join(app, 'Contents'), { mode: 0o755 })
      mkdirSync(join(app, 'Contents/Private'), { mode: 0o700 })
      writeFileSync(join(app, 'Contents/Info.plist'), 'x', { mode: 0o644 })
      writeFileSync(join(app, 'Contents/embedded.provisionprofile'), 'x', { mode: 0o600 })
      expect(ownerOnlyFiles(app).sort()).toEqual([
        join(app, 'Contents/Private'),
        join(app, 'Contents/embedded.provisionprofile'),
      ].sort())
    }
    finally {
      rmSync(app, { recursive: true, force: true })
    }
  })
})
