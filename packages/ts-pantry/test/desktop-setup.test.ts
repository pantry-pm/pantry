import { expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { desktopServicePlist, registerDesktopService } from '../src/desktop/setup'
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


test('service updates retry launchd cleanup races without requesting elevation', async () => {
  const calls: string[][] = []
  let retries = 0
  await registerDesktopService('gui/501', '/user/service.plist', {
    run: async args => {
      calls.push(args)
      if (args[0] === 'bootstrap' && retries++ < 2) return { exitCode: 5, stderr: 'Bootstrap failed: 5: Input/output error' }
      return { exitCode: 0, stderr: '' }
    }, sleep: async () => {},
  })
  expect(calls).toEqual([['bootout', 'gui/501/dev.pantry.desktop'], ...Array.from({ length: 3 }, () => ['bootstrap', 'gui/501', '/user/service.plist'])])
  let attempts = 0
  await expect(registerDesktopService('gui/501', '/user/service.plist', {
    run: async args => { if (args[0] === 'bootstrap') attempts++; return { exitCode: 1, stderr: 'Permission denied' } }, sleep: async () => {},
  })).rejects.toThrow('Permission denied')
  expect(attempts).toBe(1)
})
