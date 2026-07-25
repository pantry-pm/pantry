/**
 * Registry visibility — public registry vs. private registry.
 *
 * A public registry (the default, and what registry.pantry.dev runs) serves
 * metadata and tarballs to anyone; only publishing and admin endpoints need a
 * token. A private registry serves *nothing* without a credential: metadata,
 * tarballs, binaries, search and the web UI all require either an API token
 * (`ptry_…`, or the shared registry token) or a logged-in session.
 *
 * Turn it on with one variable in the registry's environment file:
 *
 *     REGISTRY_VISIBILITY=private
 *
 * The gate is deliberately an allowlist of public paths rather than a list of
 * gated ones: a route added later is private by default, which is the only
 * direction that fails safe.
 */

import { emitPluginEvent, pluginAccessVerdict, pluginsAuthorize } from './plugins'

export type RegistryVisibility = 'public' | 'private'

export type Env = Record<string, string | undefined>

function isTruthy(value: string | undefined): boolean {
  if (!value) return false
  const v = value.trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes' || v === 'on'
}

function isFalsy(value: string | undefined): boolean {
  if (value == null) return false
  const v = value.trim().toLowerCase()
  return v === '0' || v === 'false' || v === 'no' || v === 'off'
}

/**
 * Read the configured visibility. Unset means public — an existing deployment
 * that pulls this change keeps serving exactly what it served before.
 */
export function resolveVisibility(env: Env = process.env): RegistryVisibility {
  const raw = (env.REGISTRY_VISIBILITY ?? env.PANTRY_REGISTRY_VISIBILITY ?? '').trim().toLowerCase()
  if (raw === 'private') return 'private'
  if (raw === 'public') return 'public'
  if (isTruthy(env.REGISTRY_PRIVATE)) return 'private'
  return 'public'
}

/**
 * Whether anyone can create their own account.
 *
 * Defaults to the visibility: open signups on a public registry, closed on a
 * private one. Without this, "private" would mean "private until someone
 * clicks Sign Up", which is not private at all. Operators who want self-serve
 * onboarding (usually paired with `REGISTRY_SIGNUP_DOMAINS`) set
 * `REGISTRY_ALLOW_SIGNUP=true`.
 */
export function signupsEnabled(env: Env = process.env, visibility: RegistryVisibility = resolveVisibility(env)): boolean {
  const raw = env.REGISTRY_ALLOW_SIGNUP
  if (isTruthy(raw)) return true
  if (isFalsy(raw)) return false
  return visibility === 'public'
}

/** Email domains allowed to sign up, e.g. `REGISTRY_SIGNUP_DOMAINS=acme.com,acme.dev`. Empty ⇒ any. */
export function allowedSignupDomains(env: Env = process.env): string[] {
  return (env.REGISTRY_SIGNUP_DOMAINS || '')
    .split(',')
    .map(d => d.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean)
}

/** Check an email against `REGISTRY_SIGNUP_DOMAINS`. */
export function isSignupEmailAllowed(email: string, env: Env = process.env): boolean {
  const domains = allowedSignupDomains(env)
  if (domains.length === 0) return true
  const domain = email.toLowerCase().trim().split('@')[1] || ''
  return domains.includes(domain)
}

/**
 * Paths that stay reachable without a credential even on a private registry.
 * Everything needed to *become* authenticated, plus liveness and the discovery
 * endpoint clients use to find out they need a token in the first place.
 */
const ALWAYS_PUBLIC_PATHS: ReadonlySet<string> = new Set([
  '/health',
  '/api/registry-info',
  '/login',
  '/signup',
  '/auth/login',
  '/auth/logout',
  '/auth/signup',
  '/auth/me',
  '/favicon.ico',
  '/robots.txt',
  // Stripe can't hold one of our tokens, and the handler verifies the webhook
  // signature itself — gating it would just break payments.
  '/webhooks/stripe',
])

/**
 * Extra public path prefixes, e.g. `REGISTRY_PUBLIC_PATHS=/,/packages/@acme/sdk`.
 * A bare `/` means only the root path, not "everything".
 */
export function extraPublicPaths(env: Env = process.env): string[] {
  return (env.REGISTRY_PUBLIC_PATHS || '')
    .split(',')
    .map(p => p.trim())
    .filter(Boolean)
}

/** Whether a path is served without authentication on a private registry. */
export function isPublicPath(path: string, env: Env = process.env): boolean {
  if (ALWAYS_PUBLIC_PATHS.has(path)) return true

  for (const prefix of extraPublicPaths(env)) {
    if (prefix === '/') {
      if (path === '/') return true
      continue
    }
    if (path === prefix || path.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`))
      return true
  }

  return false
}

/** Resolved caller identity for a request, as far as the built-in checks can tell. */
export interface ReaderIdentity {
  authenticated: boolean
  userId: string | null
}

export interface ReadAccessOptions {
  visibility?: RegistryVisibility
  env?: Env
  /** Resolve the caller from a Bearer token or session cookie. */
  identify: (req: Request) => Promise<ReaderIdentity>
  /** CORS headers to echo on the rejection. */
  corsHeaders?: Record<string, string>
}

/** Does this look like a browser navigating, rather than a CLI or fetch()? */
function wantsHtml(req: Request): boolean {
  if (req.method !== 'GET') return false
  const accept = req.headers.get('accept') || ''
  return accept.includes('text/html')
}

/**
 * The gate. Returns a rejection Response when the request must not proceed, or
 * null when it may.
 *
 * Browsers get bounced to the login page with a `next` parameter; everything
 * else gets a 401 with `WWW-Authenticate` and a hint naming the exact command
 * that fixes it, because the alternative — a bare 401 during `pantry install` —
 * tells the user nothing about what to do.
 */
export async function enforceReadAccess(
  req: Request,
  url: URL,
  options: ReadAccessOptions,
): Promise<Response | null> {
  const env = options.env ?? process.env
  const visibility = options.visibility ?? resolveVisibility(env)
  const path = url.pathname
  const cors = options.corsHeaders ?? {}

  const publicPath = visibility === 'public' || isPublicPath(path, env)

  // Identify the caller when the answer can matter: the path is gated, or a
  // plugin decides access and wants to know who is asking. On a public registry
  // with no policy plugins this stays zero work, which is most requests.
  const anonymous: ReaderIdentity = { authenticated: false, userId: null }
  const identity = publicPath && !(await pluginsAuthorize())
    ? anonymous
    : await options.identify(req)

  const verdict = await pluginAccessVerdict({
    req,
    url,
    path,
    method: req.method,
    visibility,
    userId: identity.userId,
  })

  if (verdict === 'allow') return null
  if (verdict !== 'deny') {
    if (publicPath) return null
    if (identity.authenticated) {
      emitPluginEvent({ type: 'access-granted', path, method: req.method, userId: identity.userId })
      return null
    }
  }

  const reason = verdict === 'deny' ? 'Denied by access policy' : 'Authentication required'
  emitPluginEvent({ type: 'access-denied', path, method: req.method, reason })

  if (wantsHtml(req) && verdict !== 'deny') {
    return new Response(null, {
      status: 302,
      headers: { ...cors, Location: `/login?next=${encodeURIComponent(path + url.search)}` },
    })
  }

  const registryUrl = env.BASE_URL || url.origin
  return Response.json(
    {
      error: reason,
      ...(verdict === 'deny'
        ? {}
        : {
            hint: `This registry is private. Store a token with: pantry token set --registry ${registryUrl}`,
            docs: 'https://pantry.dev/self-hosting',
          }),
    },
    {
      status: verdict === 'deny' ? 403 : 401,
      headers: {
        ...cors,
        ...(verdict === 'deny' ? {} : { 'WWW-Authenticate': 'Bearer realm="pantry-registry"' }),
      },
    },
  )
}

/**
 * The public description of this registry, served at `/api/registry-info` even
 * when everything else is gated. Clients (and humans with curl) use it to tell
 * "this registry is private and I need a token" apart from "this package does
 * not exist".
 */
export function registryInfo(env: Env = process.env, baseUrl?: string): {
  visibility: RegistryVisibility
  requiresAuth: boolean
  signupsEnabled: boolean
  loginUrl?: string
  docs: string
} {
  const visibility = resolveVisibility(env)
  const base = (baseUrl || env.BASE_URL || '').replace(/\/$/, '')
  return {
    visibility,
    requiresAuth: visibility === 'private',
    signupsEnabled: signupsEnabled(env, visibility),
    ...(base ? { loginUrl: `${base}/login` } : {}),
    docs: 'https://pantry.dev/self-hosting',
  }
}
