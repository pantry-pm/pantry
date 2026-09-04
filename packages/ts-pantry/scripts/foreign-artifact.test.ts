import { afterEach, describe, expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { verifyForeignArtifact } from './build-package'

const directories: string[] = []

function temporaryInstall(): string {
  const directory = mkdtempSync(join(tmpdir(), 'pantry-foreign-artifact-'))
  directories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

describe('foreign artifact verification', () => {
  test('accepts a non-empty platform-independent data package', () => {
    const prefix = temporaryInstall()
    mkdirSync(join(prefix, 'ssl'), { recursive: true })
    writeFileSync(join(prefix, 'ssl', 'cert.pem'), 'certificate data')

    expect(() => verifyForeignArtifact(prefix, 'darwin-arm64')).not.toThrow()
  })

  test('rejects an empty install', () => {
    const prefix = temporaryInstall()

    expect(() => verifyForeignArtifact(prefix, 'darwin-arm64')).toThrow(/no non-empty files/)
  })

  test('rejects a native binary for the wrong operating system', () => {
    const prefix = temporaryInstall()
    mkdirSync(join(prefix, 'lib'), { recursive: true })
    copyFileSync('/bin/ls', join(prefix, 'lib', 'native-library'))
    const foreignPlatform = process.platform === 'darwin' ? 'linux-arm64' : 'darwin-x86-64'

    expect(() => verifyForeignArtifact(prefix, foreignPlatform)).toThrow(/expected .* magic/)
  })
})
