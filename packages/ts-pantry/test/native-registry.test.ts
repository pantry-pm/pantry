import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NativeCommand } from '../src/native/command'
import { readNativeAppConfig } from '../src/native/config'
import { publishNativeRegistry, publishPreparedNativeRegistry } from '../src/native/registry'

test('registry delivery archives the qualified app, preserves its identity and records the clean verdict without credentials', async () => {
  const root = mkdtempSync(join(tmpdir(), 'native-registry-'))
  try {
    writeFileSync(join(root, 'pantry.json'), JSON.stringify({ native: { macos: { notarize: true }, registry: { domain: 'github.com/stacksjs/launchpad' } } }))
    const app = join(root, 'dist/Launchpad.app')
    for (const directory of ['Contents/MacOS', 'Contents/Resources']) mkdirSync(join(app, directory), { recursive: true })
    writeFileSync(join(app, 'Contents/MacOS/Launchpad'), Buffer.from('cffaedfe0000', 'hex'))
    for (const file of ['Contents/Info.plist', 'Contents/Resources/index.html', 'Contents/Resources/craft.json']) writeFileSync(join(app, file), '{}')
    const calls: string[] = []
    const metadata = { CFBundleIdentifier: 'com.stacksjs.launchpad', CFBundleShortVersionString: '1.0.1', CFBundleVersion: '13' }
    const command: NativeCommand = async (bin, args) => {
      calls.push(`${bin} ${args.join(' ')}`)
      if (bin === 'tar') {
        const process = Bun.spawnSync([bin, ...args])
        return { exitCode: process.exitCode, stdout: process.stdout.toString(), stderr: process.stderr.toString() }
      }
      return { exitCode: 0, stderr: '', stdout: bin === 'plutil' ? JSON.stringify(metadata) : bin === 'lipo' ? 'arm64' : bin === 'codesign' ? 'Authority=Developer ID Application: Test' : bin === 'spctl' ? 'source=Notarized Developer ID' : '' }
    }
    let uploaded = false
    const prepared = { config: readNativeAppConfig(root)!, files: [], version: '1.0.1', artifact: { path: join(root, 'dist/Launchpad.dmg'), appPath: app, name: 'Launchpad', bundleId: metadata.CFBundleIdentifier, version: '1.0.1', buildNumber: '13', target: 'macos' } }
    const result = await publishPreparedNativeRegistry(root, prepared, {
      command, env: { PANTRY_TOKEN: 'test-secret-never-in-receipt', GITHUB_SHA: 'a'.repeat(40) },
      publish: async options => {
        uploaded = true
        expect(options.platforms).toEqual(['darwin-arm64'])
        expect(options.token).toBe('test-secret-never-in-receipt')
        expect(options.size).toBeGreaterThan(0)
        const contents = Bun.spawnSync(['tar', '-tzf', options.filePath]).stdout.toString()
        expect(contents).toContain('Launchpad.app/Contents/MacOS/Launchpad')
        expect(calls.findIndex(call => call.includes('stapler validate'))).toBeLessThan(calls.findIndex(call => call.startsWith('tar ')))
        return { success: true, domain: options.domain, version: options.version, platforms: { 'darwin-arm64': { tarball: 'binaries/app.tar.gz', sha256: 'b'.repeat(64), size: options.size, uploadedAt: new Date().toISOString() } }, scan: { verdict: 'clean', engine: 'test', artifactSha256: 'b'.repeat(64) } }
      },
    })
    expect(uploaded).toBe(true)
    const receipt = readFileSync(result.receipt, 'utf8')
    expect(receipt).toContain('com.stacksjs.launchpad')
    expect(receipt).toContain('a'.repeat(40))
    expect(receipt).not.toContain('test-secret-never-in-receipt')
    await expect(publishPreparedNativeRegistry(root, prepared, { command, env: { PANTRY_TOKEN: 'test' } })).rejects.toThrow('overwrite')
    await expect(publishPreparedNativeRegistry(root, { ...prepared, artifact: { ...prepared.artifact, appPath: join(root, '.pantry/native/app-store/Launchpad.app') } }, { command, env: { PANTRY_TOKEN: 'test' } })).rejects.toThrow('Store distribution')
  }
  finally { rmSync(root, { recursive: true, force: true }) }
})

test('registry publishing rejects invalid targets and build numbers before accessing credentials', async () => {
  await expect(publishNativeRegistry('/absent', { buildNumber: '0' })).rejects.toThrow('positive integer')
  const root = mkdtempSync(join(tmpdir(), 'native-registry-policy-'))
  try {
    for (const registry of [{ domain: '../app' }, { domain: 'example.com/app', url: 'http://example.com' }, { domain: 'example.com/app', url: 'https://user:password@example.com' }]) {
      writeFileSync(join(root, 'pantry.json'), JSON.stringify({ native: { registry, macos: { notarize: true } } }))
      expect(() => readNativeAppConfig(root)).toThrow()
    }
  }
  finally { rmSync(root, { recursive: true, force: true }) }
})
