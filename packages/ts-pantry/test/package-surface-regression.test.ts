import { describe, expect, test } from 'bun:test'
import { aliases } from '../src/packages/aliases'
import { packages } from '../src/packages/index'

describe('Package surface regression', () => {
  test('exposes stable aliases and generated packages', () => {
    const registry = packages as Record<string, any>

    expect(aliases.memcached).toBe('memcached.org')
    expect(aliases.mail).toBe('github.com/mail-os/mail')
    expect(aliases.bun).toBe('bun.sh')
    expect(aliases.git).toBe('git-scm.org')
    expect(aliases.sqlite).toBe('sqlite.org')

    expect(registry.memcached.domain).toBe('memcached.org')
    expect(registry.memcached.name).toBe('memcached')

    expect(registry.mail.domain).toBe('github.com/mail-os/mail')
    expect(registry.mail.name).toBe('mail')
    expect(registry.mail.buildDependencies).toContain('ziglang.org@0.16.0-dev')

    expect(registry.craft.domain).toBe('craft-native.org')
    expect(registry.craft.name).toBe('craft')
  })
})
