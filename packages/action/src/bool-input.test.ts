import { afterEach, expect, test } from 'bun:test'
import { boolInput } from './index'

function setInput(name: string, value: string | undefined): void {
  const key = `INPUT_${name.replace(/ /g, '_').toUpperCase()}`
  if (value === undefined)
    delete process.env[key]
  else
    process.env[key] = value
}

afterEach(() => {
  setInput('flag', undefined)
})

test('accepts bare and quoted true/false forms', () => {
  for (const v of ['true', 'True', 'TRUE', '1', 'yes', 'on', ' true ']) {
    setInput('flag', v)
    expect(boolInput('flag', false)).toBe(true)
  }
  for (const v of ['false', 'False', 'FALSE', '0', 'no', 'off', ' false ']) {
    setInput('flag', v)
    expect(boolInput('flag', true)).toBe(false)
  }
})

test('empty input uses the fallback', () => {
  setInput('flag', '')
  expect(boolInput('flag', true)).toBe(true)
  expect(boolInput('flag', false)).toBe(false)
})

test('rejects non-boolean values', () => {
  setInput('flag', 'maybe')
  expect(() => boolInput('flag', false)).toThrow()
})
