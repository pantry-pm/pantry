import { afterEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { setupBunRuntime } from './bun-runtime'

const dirs: string[] = []
function tempBinDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pantry-action-bun-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('setup-only (install: false) Bun runtime', () => {
  test('a rejected Bun install fails the setup and keeps the download error', async () => {
    const binDir = tempBinDir()
    let linked = false
    await expect(setupBunRuntime({
      binDir,
      install: async () => {
        throw new Error('Download failed after 4 attempts: HTTP 504 Gateway Timeout')
      },
      onLinked: () => { linked = true },
    })).rejects.toThrow('Required runtime bun.sh failed to install: Download failed after 4 attempts: HTTP 504 Gateway Timeout')
    expect(linked).toBe(false)
    expect(fs.existsSync(path.join(binDir, 'bunx'))).toBe(false)
  })

  test('a successful install links bunx and exports the runtime', async () => {
    const binDir = tempBinDir()
    let linked = false
    await setupBunRuntime({
      binDir,
      install: async () => {
        fs.writeFileSync(path.join(binDir, 'bun'), '#!/bin/sh\n', { mode: 0o755 })
      },
      onLinked: () => { linked = true },
    })
    expect(linked).toBe(true)
    expect(fs.readlinkSync(path.join(binDir, 'bunx'))).toBe(path.join(binDir, 'bun'))
  })

  test('a stale bunx link is replaced rather than failing setup', async () => {
    const binDir = tempBinDir()
    fs.symlinkSync('/nonexistent/bun', path.join(binDir, 'bunx'))
    await setupBunRuntime({
      binDir,
      install: async () => {
        fs.writeFileSync(path.join(binDir, 'bun'), '#!/bin/sh\n', { mode: 0o755 })
      },
    })
    expect(fs.readlinkSync(path.join(binDir, 'bunx'))).toBe(path.join(binDir, 'bun'))
  })
})
