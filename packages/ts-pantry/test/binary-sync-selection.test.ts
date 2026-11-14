import { expect, test } from 'bun:test'
import { sanitizeDomainList } from '../scripts/binary-sync-packages'

test('metadata scope preserves domains when the publisher requests exact versions', () => {
  expect(sanitizeDomainList('ziglang.org@0.17.1.1,bun.com@1.4.4,google.com/chrome@155.0.8059.84.1'))
    .toEqual(['ziglang.org', 'bun.com', 'google.com/chrome'])
})

test('metadata scope retains unpinned domain list behavior', () => {
  expect(sanitizeDomainList(' bun.com, , ziglang.org ,google.com/chrome '))
    .toEqual(['bun.com', 'ziglang.org', 'google.com/chrome'])
})

test('metadata repair refuses an incomplete version pin', () => {
  expect(() => sanitizeDomainList('ziglang.org@')).toThrow('needs a version')
})
