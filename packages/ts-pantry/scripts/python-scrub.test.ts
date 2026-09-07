import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const buildkit = readFileSync(join(import.meta.dir, 'buildkit.ts'), 'utf8')

describe('Debian setuptools scrub', () => {
  // The scrub removes Debian's patched setuptools from dist-packages, which
  // otherwise shadows anything pip installs. It must not leave the .pth that
  // imports the module it deleted: distutils-precedence.pth runs at every
  // interpreter startup, so an orphaned one makes every later `python3` in the
  // build raise ModuleNotFoundError — which is how mergestat-lite failed on
  // every linux run of the sweep.
  test('removes distutils-precedence.pth alongside _distutils_hack', () => {
    expect(buildkit).toContain('/usr/lib/python3/dist-packages/_distutils_hack*')
    expect(buildkit).toContain('/usr/lib/python3/dist-packages/distutils-precedence.pth')
  })

  test('the removal is still one continued command, not two', () => {
    // Each path but the last carries a line continuation; the last carries the
    // redirect. A missing backslash would silently turn the tail of the list
    // into separate commands run outside `sudo`.
    const scrub = buildkit.slice(
      buildkit.indexOf('sudo rm -rf /usr/lib/python3/dist-packages/setuptools*'),
      buildkit.indexOf('python3 -m pip install --break-system-packages'),
    )
    const paths = scrub.match(/\/usr\/lib\/python3\/dist-packages\/[^\s']+/g) ?? []
    expect(paths.length).toBeGreaterThanOrEqual(5)
    expect(scrub).toContain('2>/dev/null || true')
  })
})
