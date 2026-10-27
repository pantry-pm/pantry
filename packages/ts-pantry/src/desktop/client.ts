export const desktopBridgeUrl = 'http://127.0.0.1:46473'
export interface DesktopInstallJob {
  id: string
  requestId: string
  domain: string
  /** Added in 0.11.141; absent on jobs created by older desktop services. */
  kind?: 'app' | 'cli' | 'library' | 'font'
  startedAt?: string
  timezoneOffset?: number
  status: 'queued' | 'running' | 'succeeded' | 'failed'
  output: string
  createdAt: string
  finishedAt?: string
  error?: string
}
export interface DesktopInstalledPackage { name: string, version: string, applicationPath?: string }
export type DesktopFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export class PantryDesktopError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'PantryDesktopError'
  }
}

/** A transport client only. It contains no installer, executable or shell implementation. */
export class PantryDesktopClient {
  private readonly baseUrl: string
  constructor(private options: { token?: string, fetch?: DesktopFetch, baseUrl?: string } = {}) {
    const url = new URL(options.baseUrl ?? desktopBridgeUrl)
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
      throw new Error('Pantry Desktop must use an IPv4 loopback address')
    this.baseUrl = url.origin
  }

  private async request(path: string, init: RequestInit = {}) {
    const response = await (this.options.fetch ?? globalThis.fetch)(this.baseUrl + path, {
      ...init, signal: init.signal ?? AbortSignal.timeout(15000), headers: {
        ...(this.options.token ? { authorization: `Bearer ${this.options.token}` } : {}),
        ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers,
      },
    })
    const body = await response.json() as Record<string, unknown>
    if (!response.ok) throw new PantryDesktopError(String(body.error || `Pantry Desktop request failed (${response.status})`), response.status)
    return body
  }

  async health(): Promise<Record<string, unknown>> { return await this.request('/health') }
  async pair(code: string, name: string): Promise<string> {
    const response = await this.request('/pair', { method: 'POST', body: JSON.stringify({ code, name }) })
    if (typeof response.token !== 'string') throw new Error('Pantry did not return a connection token')
    return response.token
  }

  async installed(): Promise<DesktopInstalledPackage[]> { return (await this.request('/v1/installed')).packages as DesktopInstalledPackage[] }
  async install(domain: string, requestId: string = crypto.randomUUID()): Promise<DesktopInstallJob> {
    return (await this.request('/v1/install', { method: 'POST', body: JSON.stringify({ domain, requestId }) })).job as DesktopInstallJob
  }

  async jobs(): Promise<DesktopInstallJob[]> { return (await this.request('/v1/jobs')).jobs as DesktopInstallJob[] }
  async job(id: string): Promise<DesktopInstallJob> { return (await this.request(`/v1/jobs/${encodeURIComponent(id)}`)).job as DesktopInstallJob }
  async disconnect(): Promise<void> { await this.request('/v1/connection', { method: 'DELETE' }) }
}
