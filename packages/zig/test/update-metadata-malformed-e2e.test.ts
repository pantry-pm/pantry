import { describe, it } from 'bun:test'
import { verifyMetadataUpdate } from './update-metadata-fixture'

const enabled = !!process.env.PANTRY_SOURCE_CLI && ['darwin', 'linux'].includes(process.platform)
describe.skipIf(!enabled)('source CLI metadata malformed JSON ownership', () => {
  it('rejects HTTP200 malformed JSON without changing product state', async () => {
    await verifyMetadataUpdate('malformed')
  }, 90_000)
})
