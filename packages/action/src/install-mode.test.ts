import { describe, expect, test } from 'bun:test'
import { selectSystemPackages, shouldInstallWorkspace } from './install-mode'

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
})
