import { describe, expect, it } from 'bun:test'
import { retryGitHubReleaseOperation, uploadReleaseAssetReliably } from './release-upload'

describe('retryGitHubReleaseOperation', () => {
  it('retries transient GitHub control-plane failures', async () => {
    let attempts = 0
    const warnings: string[] = []

    const result = await retryGitHubReleaseOperation('Create release', async () => {
      attempts += 1
      if (attempts < 3)
        throw Object.assign(new Error('Service Unavailable'), { status: 503 })
      return 'created'
    }, {
      sleep: async () => {},
      onRetry: warning => warnings.push(warning),
    })

    expect(result).toBe('created')
    expect(attempts).toBe(3)
    expect(warnings).toHaveLength(2)
  })

  it('does not retry permanent failures', async () => {
    let attempts = 0
    await expect(retryGitHubReleaseOperation('Create release', async () => {
      attempts += 1
      throw Object.assign(new Error('Resource not accessible'), { status: 403 })
    }, { sleep: async () => {} })).rejects.toThrow('Resource not accessible')

    expect(attempts).toBe(1)
  })
})

describe('uploadReleaseAssetReliably', () => {
  it('retries transient GitHub release policy failures', async () => {
    let uploads = 0
    const delays: number[] = []

    const result = await uploadReleaseAssetReliably({
      name: 'buddy.zip',
      size: 42,
      upload: async () => {
        uploads += 1
        if (uploads < 3)
          throw new Error('Error creating policy')
      },
      listAssets: async () => [],
      deleteAsset: async () => {},
      sleep: async (delay) => { delays.push(delay) },
    })

    expect(result).toBe('uploaded')
    expect(uploads).toBe(3)
    expect(delays).toEqual([2000, 4000])
  })

  it('reconciles an upload that succeeded despite an error response', async () => {
    const result = await uploadReleaseAssetReliably({
      name: 'buddy.zip',
      size: 42,
      upload: async () => { throw new Error('Error updating policy') },
      listAssets: async () => [{ id: 1, name: 'buddy.zip', size: 42, state: 'uploaded' }],
      deleteAsset: async () => { throw new Error('must not delete a complete asset') },
    })

    expect(result).toBe('reconciled')
  })

  it('deletes a stale duplicate before retrying', async () => {
    let uploads = 0
    const deleted: number[] = []

    const result = await uploadReleaseAssetReliably({
      name: 'buddy.zip',
      size: 42,
      upload: async () => {
        uploads += 1
        if (uploads === 1)
          throw Object.assign(new Error('already_exists'), { status: 422 })
      },
      listAssets: async () => [{ id: 7, name: 'buddy.zip', size: 12, state: 'uploaded' }],
      deleteAsset: async id => { deleted.push(id) },
      sleep: async () => {},
    })

    expect(result).toBe('uploaded')
    expect(deleted).toEqual([7])
    expect(uploads).toBe(2)
  })

  it('does not retry permanent authorization failures', async () => {
    let uploads = 0

    await expect(uploadReleaseAssetReliably({
      name: 'buddy.zip',
      size: 42,
      upload: async () => {
        uploads += 1
        throw Object.assign(new Error('Resource not accessible'), { status: 403 })
      },
      listAssets: async () => [],
      deleteAsset: async () => {},
      sleep: async () => {},
    })).rejects.toThrow('Resource not accessible')

    expect(uploads).toBe(1)
  })

  it('caps backoff while keeping a multi-minute transient retry window', async () => {
    const delays: number[] = []

    await expect(uploadReleaseAssetReliably({
      name: 'buddy.zip',
      size: 42,
      maxAttempts: 6,
      retryDelayMs: 10000,
      upload: async () => { throw Object.assign(new Error('Service Unavailable'), { status: 503 }) },
      listAssets: async () => [],
      deleteAsset: async () => {},
      sleep: async (delay) => { delays.push(delay) },
    })).rejects.toThrow('Service Unavailable')

    expect(delays).toEqual([10000, 20000, 30000, 30000, 30000])
  })
})
