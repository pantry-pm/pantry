import { describe, it } from 'bun:test'
import { verifyUpdateInstallCompletion } from './update-install-completion-fixture'

const enabled = !!process.env.PANTRY_SOURCE_CLI && ['darwin', 'linux'].includes(process.platform)
describe.skipIf(!enabled)('source CLI successful update installation', () => {
  it('returns success after the real selected native archive and lock are installed', async () => {
    await verifyUpdateInstallCompletion('success')
  }, 90_000)
})
