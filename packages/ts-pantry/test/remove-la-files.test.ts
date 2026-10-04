import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeLaFiles } from '../scripts/fix-up'

describe('removeLaFiles', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  // libpng installs lib/libpng.la -> libpng16.la. Whichever readdir returns
  // first, both must go and the fix-up must not throw: on linux-arm64 the
  // target came first, the link was left dangling, and stat() threw ENOENT.
  for (const order of ['link first', 'target first']) {
    test(`removes a .la and the link to it (${order})`, () => {
      const prefix = mkdtempSync(join(tmpdir(), 'pantry-la-'))
      dirs.push(prefix)
      const lib = join(prefix, 'lib')
      mkdirSync(lib)
      writeFileSync(join(lib, 'libpng16.la'), 'libdir=/tmp/buildkit-install-libpng.org/lib\n')
      symlinkSync('libpng16.la', join(lib, 'libpng.la'))
      writeFileSync(join(lib, 'libpng16.so.16'), '')
      if (order === 'target first')
        rmSync(join(lib, 'libpng16.la')) // what an earlier iteration did

      expect(() => removeLaFiles(prefix)).not.toThrow()
      expect(existsSync(join(lib, 'libpng16.la'))).toBe(false)
      expect(lstatSync(join(lib, 'libpng.la'), { throwIfNoEntry: false })).toBeUndefined()
      expect(existsSync(join(lib, 'libpng16.so.16'))).toBe(true)
    })
  }
})
