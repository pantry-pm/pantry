import { describe, expect, test } from 'bun:test'
import { isRequiredHealthCheck } from '../scripts/build-package'

describe('health check policy', () => {
  test('only opts in object tests marked required', () => {
    expect(isRequiredHealthCheck('tool --version')).toBe(false)
    expect(isRequiredHealthCheck(['tool --version'])).toBe(false)
    expect(isRequiredHealthCheck({ script: ['tool --version'] })).toBe(false)
    expect(isRequiredHealthCheck({ required: true, script: ['tool --version'] })).toBe(true)
  })
})
