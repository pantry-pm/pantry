import { afterEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { deliverReleaseToAppStore, isExistingAppStoreUpload, parseAppStoreDeliveryId } from './release-app-store'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true })
})

function packageFixture(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pantry-app-store-test-'))
  directories.push(directory)
  const pkg = path.join(directory, 'App.pkg')
  fs.writeFileSync(pkg, 'signed')
  return pkg
}

describe('Mac App Store release delivery', () => {
  test('validates the signature before upload and never exposes the key on argv', async () => {
    const calls: Array<{ command: string, args: string[], env?: NodeJS.ProcessEnv }> = []
    const receipt = await deliverReleaseToAppStore({
      package: packageFixture(),
      apiKeyId: 'KEY123',
      issuerId: 'issuer',
      privateKey: 'PRIVATE KEY',
      validateOnly: false,
      retryExisting: true,
      dryRun: false,
    }, {
      platform: 'darwin',
      now: () => '2026-07-28T00:00:00.000Z',
      async runCommand(command, args, env) {
        calls.push({ command, args, env })
        if (args.includes('--upload-app'))
          return { exitCode: 0, stdout: 'RequestUUID: 12345678-abcd-1234-abcd-1234567890ab', stderr: '' }
        return { exitCode: 0, stdout: 'ok', stderr: '' }
      },
    })

    expect(calls.map(call => [call.command, call.args[0]])).toEqual([
      ['pkgutil', '--check-signature'],
      ['xcrun', 'altool'],
      ['xcrun', 'altool'],
    ])
    expect(calls.flatMap(call => call.args)).not.toContain('PRIVATE KEY')
    expect(calls[1].env?.API_PRIVATE_KEYS_DIR).toContain('pantry-app-store-')
    expect(receipt).toMatchObject({
      validated: true,
      uploaded: true,
      deliveryId: '12345678-abcd-1234-abcd-1234567890ab',
    })
  })

  test('supports validation-only delivery', async () => {
    const calls: string[][] = []
    const receipt = await deliverReleaseToAppStore({
      package: packageFixture(),
      apiKeyId: 'KEY123',
      issuerId: 'issuer',
      privateKey: 'PRIVATE KEY',
      validateOnly: true,
      retryExisting: true,
      dryRun: false,
    }, {
      platform: 'darwin',
      async runCommand(_command, args) {
        calls.push(args)
        return { exitCode: 0, stdout: 'ok', stderr: '' }
      },
    })

    expect(calls.some(args => args.includes('--upload-app'))).toBeFalse()
    expect(receipt.validated).toBeTrue()
    expect(receipt.uploaded).toBeFalse()
  })

  test('rejects non-macOS execution before invoking tools', async () => {
    await expect(deliverReleaseToAppStore({
      package: packageFixture(),
      apiKeyId: 'KEY123',
      issuerId: 'issuer',
      privateKey: 'PRIVATE KEY',
      validateOnly: false,
      retryExisting: true,
      dryRun: false,
    }, {
      platform: 'linux',
    })).rejects.toThrow('requires a macOS runner')
  })

  test('recognizes repeatable duplicate uploads and delivery IDs', () => {
    expect(isExistingAppStoreUpload('Bundle version 42 has already been uploaded')).toBeTrue()
    expect(parseAppStoreDeliveryId('delivery id: abcdef12-3456-7890-abcd-ef1234567890')).toBe('abcdef12-3456-7890-abcd-ef1234567890')
  })
})
