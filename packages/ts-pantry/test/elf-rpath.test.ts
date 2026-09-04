import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { applyElfRpath } from '../scripts/fix-up'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

describe('ELF RPATH fix-up', () => {
  test('passes the loader origin through without shell expansion', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pantry-patchelf-'))
    const argsFile = join(dir, 'args')
    const patchelf = join(dir, 'patchelf')
    tempDirs.push(dir)
    writeFileSync(patchelf, `#!/bin/sh\nprintf "%s\\n" "$@" > "${argsFile}"\n`)
    chmodSync(patchelf, 0o755)

    applyElfRpath('/tmp/tool', '$ORIGIN/../lib', patchelf)

    expect(readFileSync(argsFile, 'utf8').split('\n')).toEqual([
      '--force-rpath',
      '--set-rpath',
      '$ORIGIN/../lib',
      '/tmp/tool',
      '',
    ])
  })
})
