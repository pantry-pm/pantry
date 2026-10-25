import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'bun:test'
import { AppStoreConnectClient } from '../src/app-store-connect'
import { attachAppStoreEncryptionDeclaration } from '../src/app-store-submission'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

function fixture(state = 'APPROVED', app = 'app-1', exempt: boolean | null = null, selected?: string) {
  const directory = mkdtempSync(join(tmpdir(), 'pantry-encryption-'))
  directories.push(directory)
  const keyPath = join(directory, 'key.p8')
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }))
  const writes: unknown[] = []
  const client = new AppStoreConnectClient({ keyId: 'TEST', issuerId: 'test', keyPath,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        writes.push(JSON.parse(String(init.body)))
        return Response.json({ data: {} })
      }
      const declaration = String(input).includes('/appEncryptionDeclarations/')
      return Response.json({ data: {
        type: declaration ? 'appEncryptionDeclarations' : 'builds', id: declaration ? 'declaration-1' : 'build-1',
        attributes: declaration ? { appEncryptionDeclarationState: state } : { usesNonExemptEncryption: exempt },
        relationships: {
          app: { data: { type: 'apps', id: declaration ? app : 'app-1' } },
          ...(selected ? { appEncryptionDeclaration: { data: { type: 'appEncryptionDeclarations', id: selected } } } : {}),
        },
      } })
    }) as typeof fetch,
  })
  return { client, writes }
}

it('attaches approved same-app compliance using the build update endpoint', async () => {
  const { client, writes } = fixture()
  await attachAppStoreEncryptionDeclaration(client, 'build-1', 'declaration-1')
  expect(writes).toEqual([{ data: {
    type: 'builds', id: 'build-1', attributes: { usesNonExemptEncryption: true },
    relationships: { appEncryptionDeclaration: { data: { type: 'appEncryptionDeclarations', id: 'declaration-1' } } },
  } }])
})

it.each(['CREATED', 'IN_REVIEW', 'REJECTED', 'EXPIRED', 'INVALID'])('refuses %s compliance without mutating Apple records', async (state) => {
  const { client, writes } = fixture(state)
  await expect(attachAppStoreEncryptionDeclaration(client, 'build-1', 'declaration-1')).rejects.toThrow('APPROVED')
  expect(writes).toEqual([])
})

it('refuses another app’s declaration and conflicting exemption answers', async () => {
  for (const f of [fixture('APPROVED', 'other-app'), fixture('APPROVED', 'app-1', false)]) {
    await expect(attachAppStoreEncryptionDeclaration(f.client, 'build-1', 'declaration-1')).rejects.toThrow()
    expect(f.writes).toEqual([])
  }
})

it('does not rewrite an already selected declaration', async () => {
  const { client, writes } = fixture('APPROVED', 'app-1', true, 'declaration-1')
  await attachAppStoreEncryptionDeclaration(client, 'build-1', 'declaration-1')
  expect(writes).toEqual([])
})
