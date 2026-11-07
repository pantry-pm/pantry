import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureQualifiedPantry } from './qualified-pantry'

const expectedVersion = 'pantry 0.11.178 (1ead8b67d)'
const nativeTest = process.platform === 'win32' ? test.skip : test
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'registry-qualified-pantry-'))
  const executable = join(cwd, 'pantry')
  const write = (version: string, exit = 0) => writeFileSync(executable, `#!/bin/sh\nprintf '%s\\n' '${version}'\nexit ${exit}\n`, { mode: 0o755 })
  return { cwd, executable, expectedVersion, write, close: () => rmSync(cwd, { recursive: true, force: true }) }
}

nativeTest('an absent or stale owned bootstrap is installed once and an exact cached CLI is reused', async () => {
  const f = fixture()
  let installed = 0
  const install = async () => { installed++; f.write(expectedVersion) }
  try {
    await ensureQualifiedPantry({ ...f, install })
    expect(installed).toBe(1)
    await ensureQualifiedPantry({ ...f, install })
    expect(installed).toBe(1)
    f.write('pantry 0.11.180 (5c7cc72c1)')
    await ensureQualifiedPantry({ ...f, install })
    expect(installed).toBe(2)
    f.write('pantry 0.11.178 (different)')
    await ensureQualifiedPantry({ ...f, install })
    expect(installed).toBe(3)
  }
  finally { f.close() }
})

nativeTest('a declared external CLI is never replaced or silently accepted when unqualified', async () => {
  const f = fixture()
  let installed = false
  const install = async () => { installed = true }
  try {
    await expect(ensureQualifiedPantry({ ...f, externallyManaged: true, install })).rejects.toThrow('declared Pantry')
    f.write('pantry 0.11.180 (5c7cc72c1)')
    await expect(ensureQualifiedPantry({ ...f, externallyManaged: true, install })).rejects.toThrow('0.11.180')
    f.write(expectedVersion)
    await ensureQualifiedPantry({ ...f, externallyManaged: true, install })
    expect(installed).toBe(false)
  }
  finally { f.close() }
})

nativeTest('installation must restore the exact version and source with a successful version command', async () => {
  const f = fixture()
  try {
    await expect(ensureQualifiedPantry({ ...f, install: async () => { f.write('pantry 0.11.178 (wrong)') } })).rejects.toThrow('requires')
    await expect(ensureQualifiedPantry({ ...f, install: async () => { f.write(expectedVersion, 1) } })).rejects.toThrow('requires')
  }
  finally { f.close() }
})
