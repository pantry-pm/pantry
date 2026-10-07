import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { installRequiredSystemPackages, needsJsInstall, selectSystemPackages, shouldInstallWorkspace } from './install-mode'

describe('Pantry Action install mode', () => {
  test('service-only setup does not install project dependencies', () => {
    let detected = false
    expect(selectSystemPackages('', true, () => {
      detected = true
      return ['zig']
    })).toEqual([])
    expect(detected).toBe(false)
    expect(shouldInstallWorkspace('', true)).toBe(false)
  })

  test('normal and explicit installs preserve their dependency selection', () => {
    expect(selectSystemPackages('', false, () => ['zig', 'node'])).toEqual(['zig', 'node'])
    expect(selectSystemPackages('zig@0.16.0 bun@1.3.14', true, () => [])).toEqual(['zig@0.16.0', 'bun@1.3.14'])
    expect(shouldInstallWorkspace('', false)).toBe(true)
    expect(shouldInstallWorkspace('zig', false)).toBe(false)
  })

  test('required system package failures reject the action', async () => {
    const attempted: string[] = []
    await expect(installRequiredSystemPackages(['bun.sh', 'zig@0.17.0-dev'], async packageSpec => {
      attempted.push(packageSpec)
      if (packageSpec.startsWith('zig')) throw new Error('socket hang up')
    })).rejects.toThrow('Required system package zig@0.17.0-dev failed to install: socket hang up')
    expect(attempted).toEqual(['bun.sh', 'zig@0.17.0-dev'])
  })

  // The cache holds pantry/ only: a cache hit on a fresh checkout has no
  // node_modules, and the JS install has to run again to create it.
  test('a project with JS deps needs its JS install until node_modules is marked', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pantry-js-'))
    try {
      expect(needsJsInstall(dir)).toBe(false)
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { 'bun.sh': '^1.4.2', 'ziglang.org': '0.16.0' } }))
      expect(needsJsInstall(dir)).toBe(false)
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ devDependencies: { typescript: '^5.9.3' } }))
      expect(needsJsInstall(dir)).toBe(true)
      fs.mkdirSync(path.join(dir, 'node_modules'))
      fs.writeFileSync(path.join(dir, 'node_modules', '.pantry-js-installed'), '')
      expect(needsJsInstall(dir)).toBe(false)
      fs.writeFileSync(path.join(dir, 'package.json'), '{ not json')
      expect(needsJsInstall(dir)).toBe(false)
    }
    finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
