import { describe, expect, it } from 'bun:test'
import { uploadReleaseAssetReliably } from './release-upload'

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
      sleep: async delay => delays.push(delay),
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
})
