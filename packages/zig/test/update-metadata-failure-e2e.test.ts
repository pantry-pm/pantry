import { describe, it } from 'bun:test'
import { verifyMetadataUpdate } from './update-metadata-fixture'

const enabled = !!process.env.PANTRY_SOURCE_CLI && ['darwin', 'linux'].includes(process.platform)
describe.skipIf(!enabled)('source CLI metadata failure ownership', () => {
  it('returns nonzero for failed metadata without changing declarations or installing', async () => {
    await verifyMetadataUpdate('unavailable')
  }, 90_000)
})
