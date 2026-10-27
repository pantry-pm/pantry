import { expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { desktopServicePlist } from '../src/desktop/setup'
import { secureDesktopDirectory } from '../src/desktop/service'

test('service registration passes literal paths and escapes launchd XML', () => {
  const source = desktopServicePlist('/Users/a & b/helper', '/tools/<pantry>', '/state')
  expect(source).toContain('<string>/Users/a &amp; b/helper</string>')
  expect(source).toContain('<string>/tools/&lt;pantry&gt;</string>')
  expect(source).toContain('<string>serve</string>')
  expect(source).not.toContain('/bin/sh')
})
test('service state refuses shared directories and symbolic links', () => {
  const root = mkdtempSync(join(tmpdir(), 'pantry-permissions-'))
  try {
    chmodSync(root, 0o755)
    expect(() => secureDesktopDirectory(root)).toThrow('owner-only')
    chmodSync(root, 0o700)
    symlinkSync(root, join(root, 'link'))
    expect(() => secureDesktopDirectory(join(root, 'link'))).toThrow('owner-only')
  }
  finally { rmSync(root, { recursive: true, force: true }) }
})
