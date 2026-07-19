import { describe, expect, test } from 'bun:test'
import { commitSubject, needsMacos } from './check-desktop-updates'

describe('desktop update flow', () => {
  test('routes disk images to a native macOS runner', () => {
    expect(needsMacos({ build: { script: ['hdiutil attach app.dmg'] } })).toBe(true)
    expect(needsMacos({ build: { script: ['curl app.zip', 'unzip app.zip'] } })).toBe(false)
  })

  test('describes registry-backed changes as published', () => {
    const entry = {
      domain: 'example.com',
      name: 'Example',
      kind: 'app' as const,
      repo: null,
      latest: '2.0.0',
      published: '2.0.0',
      previousPublished: '1.0.0',
      needsUpdate: false,
      host: 'ubuntu' as const,
    }

    expect(commitSubject([entry])).toBe('chore(desktop): publish app example.com 1.0.0 → 2.0.0')
  })
})
