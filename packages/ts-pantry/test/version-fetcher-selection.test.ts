import { expect, test } from 'bun:test'
import { join } from 'node:path'

test('a targeted version check rejects an unknown domain before importing unrelated recipe helpers', () => {
  const script = join(import.meta.dir, '../scripts/version-fetcher.ts')
  const result = Bun.spawnSync([process.execPath, script, '--domain', 'pantry-recipe-does-not-exist.invalid', '--dry-run'], { timeout: 15_000 })
  expect(result.exitCode).toBe(1)
  const errors = result.stderr.toString()
  expect(errors).toContain('No native recipe found for pantry-recipe-does-not-exist.invalid')
  expect(errors).not.toContain('ERROR loading')
  expect(result.stdout.toString()).not.toContain('updated to')
})
