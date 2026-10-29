import { expect, test } from 'bun:test'
import { publishNativeApple, submitNativeApple } from '../src/native/store-publish'

test('native publishing rejects invalid build numbers before reading credentials or building', async () => {
  for (const buildNumber of ['', '0', '../x', '1;run', '1.2']) {
    await expect(publishNativeApple('/nonexistent', { buildNumber })).rejects.toThrow('positive integer')
    await expect(submitNativeApple('/nonexistent', { buildNumber })).rejects.toThrow('positive integer')
  }
})
