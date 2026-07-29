import { afterEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { parseSigningIdentities, selectSigningIdentity, setupAppleSigning } from './apple-signing'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true })
})

function tempDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pantry-signing-test-'))
  directories.push(directory)
  return directory
}

const FIND_IDENTITY_OUTPUT = `
  1) 2A9B1C4D6E8F0A2B4C6D8E0F1A3B5C7D9E1F3A5B "3rd Party Mac Developer Application: Acme Inc (TEAM123)"
  2) 7F5E3D1C9B7A5F3E1D9C7B5A3F1E9D7C5B3A1F9E "3rd Party Mac Developer Installer: Acme Inc (TEAM123)"
     2 valid identities found
`

describe('signing identity discovery', () => {
  test('reads identity names out of security find-identity output', () => {
    expect(parseSigningIdentities(FIND_IDENTITY_OUTPUT)).toEqual([
      '3rd Party Mac Developer Application: Acme Inc (TEAM123)',
      '3rd Party Mac Developer Installer: Acme Inc (TEAM123)',
    ])
    expect(parseSigningIdentities('     0 valid identities found')).toEqual([])
  })

  test('never picks an application certificate to sign an installer', () => {
    const identities = parseSigningIdentities(FIND_IDENTITY_OUTPUT)
    expect(selectSigningIdentity(identities, 'application')).toBe('3rd Party Mac Developer Application: Acme Inc (TEAM123)')
    expect(selectSigningIdentity(identities, 'installer')).toBe('3rd Party Mac Developer Installer: Acme Inc (TEAM123)')

    const appOnly = ['3rd Party Mac Developer Application: Acme Inc (TEAM123)']
    expect(selectSigningIdentity(appOnly, 'installer')).toBeUndefined()
  })

  test('accepts Developer ID identities for direct distribution', () => {
    const identities = ['Developer ID Application: Acme Inc (TEAM123)', 'Developer ID Installer: Acme Inc (TEAM123)']
    expect(selectSigningIdentity(identities, 'application')).toBe('Developer ID Application: Acme Inc (TEAM123)')
    expect(selectSigningIdentity(identities, 'installer')).toBe('Developer ID Installer: Acme Inc (TEAM123)')
  })
})

describe('keychain setup', () => {
  function recordingRunner(calls: Array<{ command: string, args: string[] }>) {
    return async (command: string, args: string[]) => {
      calls.push({ command, args })
      if (args[0] === 'find-identity')
        return { exitCode: 0, stdout: FIND_IDENTITY_OUTPUT, stderr: '' }
      if (args[0] === 'list-keychains')
        return { exitCode: 0, stdout: '    "/Users/runner/Library/Keychains/login.keychain-db"\n', stderr: '' }
      return { exitCode: 0, stdout: '', stderr: '' }
    }
  }

  test('imports both certificates and reports the identities they provide', async () => {
    const calls: Array<{ command: string, args: string[] }> = []
    const outputDirectory = tempDirectory()

    const result = await setupAppleSigning({
      applicationCertificate: Buffer.from('app-cert').toString('base64'),
      installerCertificate: Buffer.from('installer-cert').toString('base64'),
      certificatePassword: 'hunter2',
      provisioningProfile: Buffer.from('profile').toString('base64'),
      outputDirectory,
    }, {
      platform: 'darwin',
      runCommand: recordingRunner(calls),
      tempDirectory: outputDirectory,
    })

    expect(result.applicationIdentity).toBe('3rd Party Mac Developer Application: Acme Inc (TEAM123)')
    expect(result.installerIdentity).toBe('3rd Party Mac Developer Installer: Acme Inc (TEAM123)')
    expect(fs.readFileSync(result.provisioningProfilePath!, 'utf8')).toBe('profile')

    const imports = calls.filter(call => call.args[0] === 'import')
    expect(imports).toHaveLength(2)

    // The password reaches `security import`, but the keychain password is
    // generated per run and never derived from it.
    expect(imports[0].args).toContain('hunter2')

    // Without the partition list, codesign blocks on a UI prompt no runner
    // can answer, so the job would hang rather than fail.
    expect(calls.some(call => call.args[0] === 'set-key-partition-list')).toBe(true)

    // The new keychain has to join the search list or the tools never see it.
    const search = calls.find(call => call.args[0] === 'list-keychains' && call.args.includes('-s'))
    expect(search?.args).toContain('/Users/runner/Library/Keychains/login.keychain-db')
    expect(search?.args).toContain(result.keychainPath)
  })

  test('deletes the decoded .p12 files once they are imported', async () => {
    const outputDirectory = tempDirectory()
    const result = await setupAppleSigning({
      applicationCertificate: Buffer.from('app-cert').toString('base64'),
      certificatePassword: 'hunter2',
      outputDirectory,
    }, {
      platform: 'darwin',
      runCommand: recordingRunner([]),
      tempDirectory: outputDirectory,
    })

    const workDirectory = path.dirname(result.keychainPath)
    expect(fs.readdirSync(workDirectory).filter(name => name.endsWith('.p12'))).toEqual([])
  })

  test('fails when the certificates provide no usable identity', async () => {
    const outputDirectory = tempDirectory()
    await expect(setupAppleSigning({
      applicationCertificate: Buffer.from('app-cert').toString('base64'),
      certificatePassword: 'hunter2',
    }, {
      platform: 'darwin',
      tempDirectory: outputDirectory,
      runCommand: async (_command, args) => {
        if (args[0] === 'find-identity')
          return { exitCode: 0, stdout: '     0 valid identities found', stderr: '' }
        if (args[0] === 'list-keychains')
          return { exitCode: 0, stdout: '', stderr: '' }
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    })).rejects.toThrow('No application signing identity')
  })

  test('surfaces the security error rather than a bare exit code', async () => {
    await expect(setupAppleSigning({
      applicationCertificate: Buffer.from('app-cert').toString('base64'),
      certificatePassword: 'wrong',
    }, {
      platform: 'darwin',
      tempDirectory: tempDirectory(),
      runCommand: async (_command, args) => args[0] === 'import'
        ? { exitCode: 1, stdout: '', stderr: 'security: MAC verification failed' }
        : { exitCode: 0, stdout: '', stderr: '' },
    })).rejects.toThrow('MAC verification failed')
  })

  test('requires a macOS runner', async () => {
    await expect(setupAppleSigning({
      applicationCertificate: 'cert',
      certificatePassword: 'hunter2',
    }, { platform: 'linux' })).rejects.toThrow('macOS runner')
  })
})
