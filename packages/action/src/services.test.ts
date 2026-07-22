import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mergeServicePackages, parseRedisVersion, parseServiceSpecs, readRedisPid, readServiceLog, redisLaunchArgs, waitForRedisPid } from './services'

describe('GitHub Actions services', () => {
  test('parses an exact Redis service and rejects ambiguous declarations', () => {
    expect(parseServiceSpecs('redis@8.8.0')).toEqual([{ name: 'redis', packageSpec: 'redis@8.8.0', expectedVersion: '8.8.0' }])
    expect(() => parseServiceSpecs('redis@7.4')).toThrow('exact semantic versions')
    expect(() => parseServiceSpecs('redis redis')).toThrow('Duplicate')
    expect(() => parseServiceSpecs('postgres@17.5.0')).toThrow('Unsupported')
  })

  test('installs declared services without overriding an explicit package version', () => {
    const services = parseServiceSpecs('redis@8.8.0')
    expect(mergeServicePackages('bun@1.3.14', services)).toBe('bun@1.3.14 redis@8.8.0')
    expect(mergeServicePackages('bun@1.3.14 redis@8.8.0', services)).toBe('bun@1.3.14 redis@8.8.0')
    expect(() => mergeServicePackages('redis@8.0.4', services)).toThrow('Conflicting')
  })

  test('builds a loopback-only, non-persistent CI service and parses its version', () => {
    const args = redisLaunchArgs('/runner/temp')
    expect(args).toContain('127.0.0.1')
    expect(args).toContain('yes')
    expect(args).toContain('no')
    expect(args.join(' ')).toContain('/runner/temp/pantry-services/redis/redis.pid')
    expect(parseRedisVersion('Redis server v=8.8.0 sha=00000000:0 malloc=libc')).toBe('8.8.0')
  })

  test('accepts only a live Redis process pidfile', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pantry-action-redis-'))
    const pidfile = join(directory, 'redis.pid')
    try {
      expect(() => readRedisPid(pidfile)).toThrow('did not create')
      writeFileSync(pidfile, 'not-a-pid')
      expect(() => readRedisPid(pidfile)).toThrow('invalid')
      writeFileSync(pidfile, String(process.pid))
      expect(readRedisPid(pidfile)).toBe(process.pid)
    }
    finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('waits for a daemonized Redis pidfile instead of racing startup', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pantry-action-redis-wait-'))
    const pidfile = join(directory, 'redis.pid')
    try {
      setTimeout(() => writeFileSync(pidfile, String(process.pid)), 25)
      expect(await waitForRedisPid(pidfile, { timeoutMs: 500, intervalMs: 5 })).toBe(process.pid)
    }
    finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('reports bounded pid readiness failures and startup logs', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pantry-action-redis-log-'))
    const pidfile = join(directory, 'redis.pid')
    const logfile = join(directory, 'redis.log')
    try {
      await expect(waitForRedisPid(pidfile, { timeoutMs: 10, intervalMs: 2 })).rejects.toThrow('within 10ms')
      expect(readServiceLog(logfile)).toBe('Redis did not create a logfile')
      writeFileSync(logfile, 'Could not create server TCP listening socket')
      expect(readServiceLog(logfile)).toContain('TCP listening socket')
    }
    finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
