import { describe, it } from 'bun:test'
import { verifyMetadataUpdate } from './update-metadata-fixture'

const enabled = !!process.env.PANTRY_SOURCE_CLI && ['darwin', 'linux'].includes(process.platform)
describe.skipIf(!enabled)('source CLI valid empty metadata ownership', () => {
  it('keeps a declaration with no available update candidate idle', async () => {
    await verifyMetadataUpdate('empty')
  }, 90_000)
})
