import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppStoreConnectClient } from '../src/app-store-connect'
import { distributeTestFlightBuild, nextBuildNumber, setTestFlightWhatsNew } from '../src/testflight'

interface Call { method: string, path: string, body?: any }

describe('TestFlight', () => {
  let directory: string
  let keyPath: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'pantry-testflight-'))
    keyPath = join(directory, 'AuthKey_TEST.p8')
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }))
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  function client(handler: (call: Call, url: URL) => Response, calls: Call[] = []): AppStoreConnectClient {
    return new AppStoreConnectClient({
      keyId: 'KEY',
      issuerId: 'issuer',
      keyPath,
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input))
        const call = { method: init?.method ?? 'GET', path: `${url.pathname}${url.search}`, body: init?.body ? JSON.parse(String(init.body)) : undefined }
        calls.push(call)
        return handler(call, url)
      }) as typeof fetch,
    })
  }

  const build = (id: string, number: string, state = 'VALID') => ({
    type: 'builds',
    id,
    attributes: { version: number, processingState: state },
    relationships: { preReleaseVersion: { data: { type: 'preReleaseVersions', id: 'pre' } } },
  })
  const included = [{ type: 'preReleaseVersions', id: 'pre', attributes: { version: '1.0.0', platform: 'MAC_OS' } }]

  test('the next build number follows the highest integer across every page', async () => {
    const asc = client((_call, url) => {
      if (url.searchParams.get('cursor') === '2')
        return Response.json({ data: [{ type: 'builds', id: 'c', attributes: { version: '12' } }] })
      return Response.json({
        data: [{ type: 'builds', id: 'a', attributes: { version: '3' } }, { type: 'builds', id: 'b', attributes: { version: '1.2.3' } }],
        links: { next: 'https://api.appstoreconnect.apple.com/v1/builds?cursor=2' },
      })
    })
    expect(await nextBuildNumber(asc, 'app')).toBe('13')
  })

  test('an app with no builds starts at 1', async () => {
    expect(await nextBuildNumber(client(() => Response.json({ data: [] })), 'app')).toBe('1')
  })

  test('waits for processing, skips automatic groups, adds manual ones and sets What to Test', async () => {
    const calls: Call[] = []
    let polls = 0
    const asc = client((call, url) => {
      if (url.pathname.endsWith('/betaGroups')) {
        return Response.json({ data: [
          { type: 'betaGroups', id: 'auto', attributes: { name: 'Team', isInternalGroup: true, hasAccessToAllBuilds: true } },
          { type: 'betaGroups', id: 'qa', attributes: { name: 'QA', isInternalGroup: true, hasAccessToAllBuilds: false } },
        ] })
      }
      if (url.pathname.endsWith('/builds') && call.method === 'GET') {
        polls++
        return Response.json({ data: polls < 2 ? [] : [build('b7', '7', polls < 3 ? 'PROCESSING' : 'VALID')], included })
      }
      if (url.pathname.endsWith('/betaBuildLocalizations') && call.method === 'GET')
        return Response.json({ data: [] })
      return url.pathname.includes('relationships')
        ? new Response(null, { status: 204 })
        : Response.json({ data: { type: 'betaBuildLocalizations', id: 'loc', attributes: {} } }, { status: 201 })
    }, calls)

    const result = await distributeTestFlightBuild(asc, {
      appId: 'app',
      version: '1.0.0',
      buildNumber: '7',
      groups: ['Team', 'QA'],
      whatsNew: 'Try the new search.',
      sleep: async () => {},
    })

    expect(polls).toBe(3)
    expect(result.build).toEqual({ id: 'b7', buildNumber: '7', version: '1.0.0', platform: 'MAC_OS' })
    expect(result.groups).toEqual([{ id: 'auto', name: 'Team', automatic: true }, { id: 'qa', name: 'QA', automatic: false }])
    const writes = calls.filter(call => call.method !== 'GET')
    expect(writes.map(call => `${call.method} ${call.path}`)).toEqual([
      'POST /v1/betaGroups/qa/relationships/builds',
      'POST /v1/betaBuildLocalizations',
    ])
    expect(writes[0]!.body).toEqual({ data: [{ type: 'builds', id: 'b7' }] })
    expect(writes[1]!.body.data.attributes).toEqual({ locale: 'en-US', whatsNew: 'Try the new search.' })
  })

  test('a group that does not exist fails before waiting on the build', async () => {
    const calls: Call[] = []
    const asc = client(() => Response.json({ data: [{ type: 'betaGroups', id: 'auto', attributes: { name: 'Team', isInternalGroup: true } }] }), calls)
    await expect(distributeTestFlightBuild(asc, { appId: 'app', version: '1.0.0', buildNumber: '1', groups: ['Teem'] }))
      .rejects
      .toThrow('TestFlight group "Teem" does not exist on this app (groups: "Team")')
    expect(calls.some(call => call.path.startsWith('/v1/builds'))).toBe(false)
  })

  test('a build that fails processing stops the wait', async () => {
    const asc = client((_call, url) => url.pathname.endsWith('/betaGroups')
      ? Response.json({ data: [{ type: 'betaGroups', id: 'auto', attributes: { name: 'Team', isInternalGroup: true, hasAccessToAllBuilds: true } }] })
      : Response.json({ data: [build('b1', '1', 'INVALID')], included }))
    await expect(distributeTestFlightBuild(asc, { appId: 'app', version: '1.0.0', buildNumber: '1', groups: ['Team'], sleep: async () => {} }))
      .rejects
      .toThrow('failed App Store Connect processing (INVALID)')
  })

  test('What to Test replaces an existing localization instead of adding a second', async () => {
    const calls: Call[] = []
    const asc = client((call) => call.method === 'GET'
      ? Response.json({ data: [{ type: 'betaBuildLocalizations', id: 'loc', attributes: { locale: 'en-US' } }] })
      : Response.json({ data: {} }), calls)
    await setTestFlightWhatsNew(asc, 'b1', 'Fixed sync.')
    expect(calls.map(call => `${call.method} ${call.path}`)).toEqual(['GET /v1/builds/b1/betaBuildLocalizations', 'PATCH /v1/betaBuildLocalizations/loc'])
  })
})
