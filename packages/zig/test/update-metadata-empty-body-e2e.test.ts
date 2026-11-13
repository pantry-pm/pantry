import { describe, it } from 'bun:test'
import { verifyMetadataUpdate } from './update-metadata-fixture'

const enabled = !!process.env.PANTRY_SOURCE_CLI && ['darwin', 'linux'].includes(process.platform)
describe.skipIf(!enabled)('source CLI metadata empty body ownership', () => {
  it('rejects an HTTP200 empty body without changing product state', async () => {
    await verifyMetadataUpdate('empty-body')
  }, 90_000)
})
