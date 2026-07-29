import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import config from './pantry.json'

describe('Pantry rpx route fragment', () => {
  test('owns each public Pantry host exactly once', () => {
    const expected = ['pantry.dev', 'registry.pantry.dev', 'www.pantry.dev']
    expect(config.slug).toBe('pantry')
    expect(config.proxies.map(route => route.to).sort()).toEqual(expected)
    expect(new Set(config.proxies.map(route => route.id)).size).toBe(expected.length)
  })

  test('routes only to the loopback registry and preserves shared gateway state', () => {
    expect(config.proxies.every(route => route.from === 'localhost:3001')).toBe(true)
    expect(config.productionCerts.certsDir).toBe('/etc/rpx/certs')
    expect(config.hostsManagement).toBe(false)
    expect(config.cleanup).toEqual({ hosts: false, certs: false })
  })

  test('reloads rpx only when route ownership changes during deploy', () => {
    const workflow = readFileSync(
      join(import.meta.dir, '../../.github/workflows/deploy-registry.yml'),
      'utf8',
    )

    expect(workflow).toContain('cmp -s infrastructure/rpx/pantry.json /etc/rpx/sites.d/pantry.json')
    expect(workflow).toContain('rm -f /etc/rpx/sites.d/pantry-registry.json')
    expect(workflow).toContain('if [ "$RPX_ROUTES_CHANGED" -eq 1 ]; then')
  })
})
