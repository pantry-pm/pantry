import { describe, expect, test } from 'bun:test'
import { installRequiredSystemPackages, selectSystemPackages, shouldInstallWorkspace } from './install-mode'

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
})
