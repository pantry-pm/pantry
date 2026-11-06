import { expect, test } from 'bun:test'
import { createBuildStatusFixture } from './build-status-test-utils'
import { BuildStatusStore, RELEASE_CLAIM_TTL_MS } from './storage/build-status'

test('a persisted lease survives restart and returns to the queue after a failed worker expires', async () => {
  const f = createBuildStatusFixture()
  await f.store.ready()
  f.store.requestRebuild('curl.se')
  f.store.requestRebuild('craft-native.org')
  const start = Date.now()
  const lease = f.store.claimQueue('123-1', start)!
  expect(lease.domains).toEqual(['curl.se', 'craft-native.org'])
  expect(f.store.getQueue(start)).toEqual([])
  expect(f.store.claimQueue('123-1', start)).toEqual(lease)
  expect(f.store.claimQueue('124-1', start)).toBeNull()
  await f.store.flush()
  const restarted = new BuildStatusStore(f.storage, f.bucket)
  await restarted.ready()
  expect(restarted.getQueue(start + RELEASE_CLAIM_TTL_MS - 1)).toEqual([])
  expect(restarted.getQueue(start + RELEASE_CLAIM_TTL_MS)).toEqual(lease.domains)
  expect(restarted.acknowledgeClaim(lease.id, start + RELEASE_CLAIM_TTL_MS)).toBe(false)
  const retry = restarted.claimQueue('125-1', start + RELEASE_CLAIM_TTL_MS)!
  expect(retry.id).not.toBe(lease.id)
  expect(retry.domains).toEqual(lease.domains)
  await restarted.flush()
})

test('acknowledgement preserves notifications arriving during a lease and persists across restart', async () => {
  const f = createBuildStatusFixture()
  await f.store.ready()
  f.store.requestRebuild('craft-native.org')
  const lease = f.store.claimQueue('123-1')!
  f.store.requestRebuild('craft-native.org')
  f.store.requestRebuild('curl.se', true)
  expect(f.store.acknowledgeClaim('unknown')).toBe(false)
  expect(f.store.acknowledgeClaim(lease.id)).toBe(true)
  expect(f.store.acknowledgeClaim(lease.id)).toBe(false)
  await f.store.flush()
  const restarted = new BuildStatusStore(f.storage, f.bucket)
  await restarted.ready()
  expect(restarted.getQueue()).toEqual(['curl.se', 'craft-native.org'])
  await restarted.flush()
})

test('old snapshots without leases still load and expired domains are deduplicated', async () => {
  const f = createBuildStatusFixture()
  f.storage.objects.set('build-status/status.json', Buffer.from(JSON.stringify({ version: 1, queue: ['curl.se'], building: [], recent: [] })))
  await f.store.ready()
  const now = Date.now()
  const lease = f.store.claimQueue('1-1', now)!
  f.store.requestRebuild('curl.se')
  expect(f.store.getQueue(lease.expiresAt)).toEqual(['curl.se'])
  await f.store.flush()
})
