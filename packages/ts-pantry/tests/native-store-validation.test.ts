import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateNativeMacApp, validateNativeMacBundle } from '../src/native'
import type { NativeArtifact, NativeCommand } from '../src/native'

const directories: string[] = []
afterEach(() => { for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pantry-store-validation-'))
  directories.push(root)
  const app = join(root, 'Example.app')
  mkdirSync(join(app, 'Contents/MacOS'), { recursive: true })
  mkdirSync(join(app, 'Contents/Resources'), { recursive: true })
  for (const file of ['Contents/Info.plist', 'Contents/Resources/index.html', 'Contents/Resources/craft.json']) writeFileSync(join(app, file), 'fixture')
  writeFileSync(join(app, 'Contents/MacOS/Example'), Buffer.from('cffaedfe', 'hex'))
  const artifact: NativeArtifact = { path: app, name: 'Example', bundleId: 'com.example.app', version: '1.0.0', buildNumber: '7', target: 'macos' }
  return { artifact, app }
}

test('Store structural qualification preserves identity checks without attempting local execution', async () => {
  const { artifact } = fixture()
  const calls: string[] = []
  const command: NativeCommand = async (name) => {
    calls.push(name)
    if (name !== 'plutil') throw new Error('Distribution provisioning does not authorize local execution')
    return { exitCode: 0, stderr: '', stdout: JSON.stringify({ CFBundleIdentifier: artifact.bundleId, CFBundleShortVersionString: artifact.version, CFBundleVersion: artifact.buildNumber }) }
  }
  await validateNativeMacBundle(artifact, undefined, command)
  expect(calls).toEqual(['plutil'])
  await expect(validateNativeMacBundle({ ...artifact, buildNumber: '8' }, undefined, command)).rejects.toThrow('identity/version')
  await expect(validateNativeMacApp(artifact, undefined, command)).rejects.toThrow('does not authorize local execution')
})

test('locally runnable builds still require a successful readiness check', async () => {
  const { artifact, app } = fixture()
  let ready = false
  const command: NativeCommand = async (name, args) => {
    if (name === 'plutil') return { exitCode: 0, stderr: '', stdout: JSON.stringify({ CFBundleIdentifier: artifact.bundleId, CFBundleShortVersionString: artifact.version, CFBundleVersion: artifact.buildNumber }) }
    expect(name).toBe(join(app, 'Contents/MacOS/Example'))
    expect(args).toEqual(['--benchmark'])
    return { exitCode: 0, stderr: '', stdout: ready ? 'ready' : 'initializing' }
  }
  await expect(validateNativeMacApp(artifact, undefined, command)).rejects.toThrow('did not report ready')
  ready = true
  await validateNativeMacApp(artifact, undefined, command)
})

test('a Craft AppKit bundle (compiled screens, no web content) is a valid native app', async () => {
  const { artifact, app } = fixture()
  rmSync(join(app, 'Contents/Resources/index.html')); rmSync(join(app, 'Contents/Resources/craft.json'))
  const plist = async (name: string) => name === 'plutil' ? { exitCode: 0, stderr: '', stdout: JSON.stringify({ CFBundleIdentifier: artifact.bundleId, CFBundleShortVersionString: artifact.version, CFBundleVersion: artifact.buildNumber }) } : undefined
  const command: NativeCommand = async (name, args) => (await plist(name)) ?? { exitCode: 0, stderr: '', stdout: args[0] === '--version' ? 'craft native macOS renderer 0.0.172 (zig-js)' : 'ready' }
  // Without its screens it is incomplete, as a web bundle without its page is.
  await expect(validateNativeMacBundle(artifact, undefined, command)).rejects.toThrow('incomplete')
  writeFileSync(join(app, 'Contents/Resources/native-screen.js'), 'screens')
  writeFileSync(join(app, 'Contents/Resources/craft-app.json'), '{}')
  await validateNativeMacBundle(artifact, undefined, command)
  // Local execution proves the host loads; it is not asked for the web build's benchmark.
  await validateNativeMacApp(artifact, undefined, command)
  const wrong: NativeCommand = async (name) => (await plist(name)) ?? { exitCode: 0, stderr: '', stdout: 'something else' }
  await expect(validateNativeMacApp(artifact, undefined, wrong)).rejects.toThrow('AppKit renderer')
})
