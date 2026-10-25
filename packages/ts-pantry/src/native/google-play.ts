import { createHash, createSign } from 'node:crypto'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import { isAndroidPackageName } from './config'

export interface GooglePlayReleaseOptions {
  bundle: string
  packageName: string
  track: string
  status: 'draft' | 'completed' | 'inProgress'
  serviceAccount: string
  userFraction?: number
  validateOnly?: boolean
  releaseName?: string
  releaseNotes?: { language: string, text: string }[]
}

const origin = 'https://androidpublisher.googleapis.com'
const oauth = 'https://oauth2.googleapis.com/token'

export interface GooglePlayReleaseReceipt {
  schemaVersion: number
  bundle: string
  packageName: string
  track: string
  status: string
  versionCode: number
  sha256: string
  editId: string
  validated: boolean
  committed: boolean
  completedAt: string
}

/** Google Play edits are transactional: validate before commit, delete on failure. */
export async function deliverReleaseToGooglePlay(options: GooglePlayReleaseOptions, dependencies: { fetch?: typeof fetch, now?: () => number } = {}): Promise<GooglePlayReleaseReceipt> {
  if (!existsSync(options.bundle) || !options.bundle.endsWith('.aab')) throw new Error('Google Play delivery requires an existing signed .aab')
  if (!isAndroidPackageName(options.packageName) || !options.track || !['draft', 'completed', 'inProgress'].includes(options.status)) throw new Error('Google Play requires a package, track and explicit release status')
  if (options.status === 'inProgress' ? !(typeof options.userFraction === 'number' && options.userFraction > 0 && options.userFraction < 1) : options.userFraction !== undefined) throw new Error('Only an inProgress release requires userFraction between zero and one')
  const account = JSON.parse(options.serviceAccount) as { client_email?: string, private_key?: string, type?: string }
  if (account.type !== 'service_account' || !account.client_email || !account.private_key) throw new Error('A Google Play service account JSON key is required')
  const request = dependencies.fetch ?? fetch
  const now = Math.floor((dependencies.now?.() ?? Date.now()) / 1000)
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const claim = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iss: account.client_email, scope: 'https://www.googleapis.com/auth/androidpublisher', aud: oauth, iat: now, exp: now + 3600 })}`
  const assertion = `${claim}.${createSign('RSA-SHA256').update(claim).sign(account.private_key, 'base64url')}`
  const auth = await request(oauth, { method: 'POST', body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }) })
  if (!auth.ok) throw new Error(`Google Play authentication failed (${auth.status})`)
  const token = await auth.json() as { access_token?: string }
  if (!token.access_token) throw new Error('Google did not return an access token')
  const headers = { Authorization: `Bearer ${token.access_token}`, 'Content-Type': 'application/json' }
  const base = `/androidpublisher/v3/applications/${encodeURIComponent(options.packageName)}/edits`
  const api = async (path: string, method: string, body?: unknown) => {
    const response = await request(`${origin}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(120_000) })
    if (!response.ok) throw new Error(`Google Play ${method} failed (${response.status}): ${await response.text()}`)
    return response.status === 204 ? {} : await response.json() as Record<string, unknown>
  }
  const edit = await api(base, 'POST', {})
  if (typeof edit.id !== 'string' || !edit.id) throw new Error('Google Play did not return an edit ID')
  const editPath = `${base}/${encodeURIComponent(edit.id)}`
  let committed = false
  try {
    const digest = createHash('sha256')
    for await (const chunk of createReadStream(options.bundle)) digest.update(chunk)
    const sha256 = digest.digest('hex')
    const upload = await request(`${origin}/upload${editPath}/bundles?uploadType=media`, {
      method: 'POST', headers: { Authorization: headers.Authorization, 'Content-Type': 'application/octet-stream', 'Content-Length': String(statSync(options.bundle).size) },
      body: createReadStream(options.bundle) as unknown as NonNullable<RequestInit['body']>, duplex: 'half', signal: AbortSignal.timeout(120_000),
    } as RequestInit)
    if (!upload.ok) throw new Error(`Google Play bundle upload failed (${upload.status}): ${await upload.text()}`)
    const bundle = await upload.json() as { versionCode?: number, sha256?: string }
    if (!Number.isSafeInteger(bundle.versionCode) || bundle.versionCode! <= 0 || bundle.sha256?.toLowerCase() !== sha256)
      throw new Error('Google Play uploaded bundle does not match the local SHA-256 and version code')
    await api(`${editPath}/tracks/${encodeURIComponent(options.track)}`, 'PUT', {
      track: options.track,
      releases: [{ status: options.status, versionCodes: [String(bundle.versionCode)], ...(options.releaseName ? { name: options.releaseName } : {}), ...(options.userFraction !== undefined ? { userFraction: options.userFraction } : {}), ...(options.releaseNotes ? { releaseNotes: options.releaseNotes } : {}) }],
    })
    await api(`${editPath}:validate`, 'POST')
    if (!options.validateOnly) {
      // Never cancel another release's in-progress review implicitly.
      const result = await api(`${editPath}:commit?changesInReviewBehavior=ERROR_IF_IN_REVIEW`, 'POST')
      if (result.id !== edit.id) throw new Error('Google Play commit did not confirm the edit ID')
      committed = true
    }
    return { schemaVersion: 1, bundle: basename(options.bundle), packageName: options.packageName, track: options.track, status: options.status, versionCode: bundle.versionCode!, sha256, editId: edit.id, validated: true, committed, completedAt: new Date().toISOString() }
  }
  finally {
    if (!committed) await api(editPath, 'DELETE')
  }
}
