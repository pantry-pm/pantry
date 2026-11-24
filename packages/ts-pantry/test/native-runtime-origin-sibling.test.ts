import { afterEach, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { originSibling } from '../scripts/native-runtime'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

test('a vendored binary\'s $ORIGIN loader path finds its sibling library inside the artifact', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'origin-sibling-')))
  dirs.push(root)
  // sharp's addon finds libvips in its sibling npm package through $ORIGIN.
  const addonDir = join(root, 'libexec', 'node_modules', '@img', 'sharp-linux-x64', 'lib')
  const vipsDir = join(root, 'libexec', 'node_modules', '@img', 'sharp-libvips-linux-x64', 'lib')
  mkdirSync(addonDir, { recursive: true })
  mkdirSync(vipsDir, { recursive: true })
  const addon = join(addonDir, 'sharp-linux-x64.node')
  writeFileSync(addon, '')
  writeFileSync(join(vipsDir, 'libvips-cpp.so.8.17.3'), '')
  const patchelf = join(root, 'patchelf')
  writeFileSync(patchelf, `#!/bin/sh\nprintf '%s' '$ORIGIN/:$ORIGIN/../../sharp-libvips-linux-x64/lib:/usr/local/lib'\n`)
  chmodSync(patchelf, 0o755)
  expect(originSibling(root, addon, 'libvips-cpp.so.8.17.3', patchelf)).toBe(join(vipsDir, 'libvips-cpp.so.8.17.3'))
  // Nothing found through the binary's own loader path: still undeclared.
  expect(originSibling(root, addon, 'libheif.so.1', patchelf)).toBeUndefined()
  // An $ORIGIN path that leaves the artifact does not count.
  writeFileSync(patchelf, `#!/bin/sh\nprintf '%s' '$ORIGIN/../../../../../../outside'\n`)
  expect(originSibling(root, addon, 'libvips-cpp.so.8.17.3', patchelf)).toBeUndefined()
})
