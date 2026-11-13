import { describe, it } from 'bun:test'
import { verifyUpdateInstallCompletion } from './update-install-completion-fixture'

const enabled = !!process.env.PANTRY_SOURCE_CLI && ['darwin', 'linux'].includes(process.platform)
describe.skipIf(!enabled)('source CLI thrown update installation failure', () => {
  it('propagates a real invalid-lock error without an update success summary', async () => {
    await verifyUpdateInstallCompletion('invalid-lock')
  }, 90_000)
})
