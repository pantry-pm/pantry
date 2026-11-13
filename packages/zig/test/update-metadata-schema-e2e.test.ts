import { describe, it } from 'bun:test'
import { verifyMetadataUpdate } from './update-metadata-fixture'

const enabled = !!process.env.PANTRY_SOURCE_CLI && ['darwin', 'linux'].includes(process.platform)
describe.skipIf(!enabled)('source CLI metadata wrong schema ownership', () => {
  it('rejects HTTP200 nonobject versions without changing product state', async () => {
    await verifyMetadataUpdate('wrong-schema')
  }, 90_000)
})
