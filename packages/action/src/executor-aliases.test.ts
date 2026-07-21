import type { Platform } from './types'
import { afterEach, describe, expect, it } from 'bun:test'
import { lstatSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensurePackageExecutorAliases } from './executor-aliases'

const temporaryDirectories: string[] = []

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'pantry-executor-aliases-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

describe('package executor aliases', () => {
  it('creates relative Unix symlinks for panx and pnx', () => {
    const directory = temporaryDirectory()
    const platform: Platform = { os: 'darwin', arch: 'arm64', binaryName: 'pantry', assetName: 'pantry-darwin-arm64.zip' }
    writeFileSync(join(directory, 'pantry'), 'pantry-binary')

    ensurePackageExecutorAliases(directory, platform)

    for (const alias of ['panx', 'pnx']) {
      expect(lstatSync(join(directory, alias)).isSymbolicLink()).toBe(true)
      expect(readlinkSync(join(directory, alias))).toBe('pantry')
    }
  })

  it('creates Windows executor copies without symlink privileges', () => {
    const directory = temporaryDirectory()
    const platform: Platform = { os: 'windows', arch: 'x64', binaryName: 'pantry.exe', assetName: 'pantry-windows-x64.zip' }
    writeFileSync(join(directory, 'pantry.exe'), 'pantry-binary')

    ensurePackageExecutorAliases(directory, platform)

    expect(readFileSync(join(directory, 'panx.exe'), 'utf8')).toBe('pantry-binary')
    expect(readFileSync(join(directory, 'pnx.exe'), 'utf8')).toBe('pantry-binary')
  })
})
