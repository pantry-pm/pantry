import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareScratchDirectory } from './scanner-worker'

describe('prepareScratchDirectory', () => {
  const previous = process.env.PANTRY_SCANNER_SCRATCH_DIR
  const made: string[] = []
  afterEach(() => {
    if (previous === undefined) delete process.env.PANTRY_SCANNER_SCRATCH_DIR
    else process.env.PANTRY_SCANNER_SCRATCH_DIR = previous
    for (const directory of made) rmSync(directory, { recursive: true, force: true })
    made.length = 0
  })

  it('stages under the configured root when there is room', () => {
    const root = mkdtempSync(join(tmpdir(), 'pantry-scratch-root-'))
    made.push(root)
    process.env.PANTRY_SCANNER_SCRATCH_DIR = root

    const directory = prepareScratchDirectory(1024)

    expect(directory).not.toBeNull()
    expect(directory!.startsWith(root)).toBe(true)
    expect(existsSync(directory!)).toBe(true)
  })

  it('declines to stage rather than fail when the volume cannot hold the artifact', () => {
    // Staging is an enhancement. A host whose disk is too small must lose the
    // entry-wise retry, not the ability to publish at all — and the check is a
    // preflight because a write that fails halfway has already consumed the
    // download, which costs a second one to recover.
    const root = mkdtempSync(join(tmpdir(), 'pantry-scratch-full-'))
    made.push(root)
    process.env.PANTRY_SCANNER_SCRATCH_DIR = root

    expect(prepareScratchDirectory(Number.MAX_SAFE_INTEGER)).toBeNull()
  })

  it('declines to stage when the root cannot be created at all', () => {
    // /dev/null is a file, so mkdir under it fails with ENOTDIR — the shape of
    // a misconfigured or unwritable scratch path.
    process.env.PANTRY_SCANNER_SCRATCH_DIR = '/dev/null/scan-scratch'

    expect(prepareScratchDirectory(1024)).toBeNull()
  })
})
