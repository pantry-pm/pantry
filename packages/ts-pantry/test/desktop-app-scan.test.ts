import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanInstalledApps } from '../src/desktop-apps'

test.skipIf(process.platform !== 'darwin')('application metadata reads treat bundle names as literal paths', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pantry app scan '))
  const marker = 'pantry-scan-probe-' + crypto.randomUUID()
  const name = `Example$(touch ${marker})`
  const contents = join(directory, name + '.app', 'Contents')
  try {
    mkdirSync(join(contents, 'MacOS'), { recursive: true })
    writeFileSync(join(contents, 'MacOS/demo'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    writeFileSync(join(contents, 'Info.plist'), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>demo</string><key>CFBundleShortVersionString</key><string>1.2.3</string><key>CFBundleIdentifier</key><string>dev.pantry.scanner-test</string></dict></plist>')
    expect(scanInstalledApps(directory)).toEqual([{ name, path: join(directory, name + '.app'), version: '1.2.3', bundleId: 'dev.pantry.scanner-test' }])
    expect(existsSync(join(process.cwd(), marker))).toBe(false)
  }
  finally { rmSync(directory, { recursive: true, force: true }) }
})


test.skipIf(process.platform !== 'darwin')('application discovery excludes empty and incomplete app bundles', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pantry-broken-app-'))
  try {
    mkdirSync(join(directory, 'Empty.app'))
    mkdirSync(join(directory, 'Broken.app/Contents'), { recursive: true })
    writeFileSync(join(directory, 'Broken.app/Contents/Info.plist'), '<plist version="1.0"><dict><key>CFBundleExecutable</key><string>missing</string></dict></plist>')
    expect(scanInstalledApps(directory)).toEqual([])
  }
  finally { rmSync(directory, { recursive: true, force: true }) }
})
