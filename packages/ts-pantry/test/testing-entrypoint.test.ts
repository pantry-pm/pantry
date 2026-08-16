import { describe, expect, test } from 'bun:test'
import {
  createTempDir,
  PantryService,
  testingRuntime,
  withTempDirSync,
} from '../src/testing'

describe('testing package entry point', () => {
  test('retains concrete implementations in the public facade', () => {
    expect(testingRuntime.PantryService).toBe(PantryService)
    expect(testingRuntime.createTempDir).toBe(createTempDir)
    expect(testingRuntime.withTempDirSync).toBe(withTempDirSync)
  })
})
