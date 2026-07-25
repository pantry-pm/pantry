/**
 * Registry plugins — the supported way to extend a self-hosted registry.
 *
 * A fork can always edit `server.ts`, but then every upstream pull is a merge
 * conflict. Plugins are the seam that avoids that: your code lives in your own
 * file (or your own package), and the registry loads it at boot.
 *
 * Enable with a comma-separated list of module specifiers:
 *
 *     REGISTRY_PLUGINS=./plugins/octocat.ts,@acme/pantry-audit
 *
 * Relative specifiers resolve against the registry's working directory. Each
 * module default-exports a `RegistryPlugin`, or a function returning one
 * (sync or async) so a plugin can read its own configuration at startup.
 *
 * ```ts
 * // plugins/octocat.ts
 * import type { RegistryPlugin } from '@stacksjs/registry'
 *
 * export default {
 *   name: 'octocat',
 *   // Anyone may read the packages we publish as open source…
 *   authorizeRead: ctx => ctx.path.startsWith('/packages/@acme/public-') ? 'allow' : undefined,
 *   // …and every denied request is worth knowing about.
 *   onEvent: (event) => { if (event.type === 'access-denied') console.warn(event) },
 * } satisfies RegistryPlugin
 * ```
 *
 * Load failures are fatal on purpose. A registry running in private mode with
 * a half-loaded access policy is worse than one that refuses to start.
 */

import type { RegistryVisibility } from './access'

/**
 * What a plugin says about a read request:
 * - `'allow'`  — serve it, skipping the built-in credential check
 * - `'deny'`   — refuse it, even if the caller holds a valid token
 * - `undefined`/`null` — no opinion, fall through to the next plugin and then
 *   to the built-in check
 *
 * A `'deny'` from any plugin wins over an `'allow'` from another: policies
 * compose by intersection, so adding a plugin can never widen access by
 * accident.
 */
export type AccessVerdict = 'allow' | 'deny' | undefined | null

/** The request a plugin is being asked about. */
export interface AccessRequest {
  req: Request
  url: URL
  /** `url.pathname`, for the common case. */
  path: string
  method: string
  /** Whether the registry itself is public or private. */
  visibility: RegistryVisibility
  /**
   * Who the built-in check resolved the caller to be — a user email, `_admin`
   * for the shared registry token, or null when the request carried no valid
   * credential. Plugins see this so they can layer policy on top of identity
   * (e.g. "members of this team, but only for these packages").
   */
  userId: string | null
}

/** Something worth recording: audit logs, metrics, webhooks. */
export type RegistryEvent =
  | { type: 'access-granted', path: string, method: string, userId: string | null }
  | { type: 'access-denied', path: string, method: string, reason: string }

export interface PluginContext {
  url: URL
  path: string
  method: string
  visibility: RegistryVisibility
}

export interface RegistryPlugin {
  /** Identifies the plugin in logs and errors. */
  name: string

  /**
   * Serve a request yourself. Called before the registry's own routes, so a
   * plugin can add endpoints (`/api/teams`) or override built-in ones.
   * Return null/undefined to let the registry handle it.
   *
   * Runs *after* the access gate, so in private mode a plugin route only sees
   * authenticated callers unless its path is in `REGISTRY_PUBLIC_PATHS`.
   */
  handleRequest?: (req: Request, ctx: PluginContext) => Promise<Response | null | undefined> | Response | null | undefined

  /** Decide (or decline to decide) whether a read request is allowed. */
  authorizeRead?: (ctx: AccessRequest) => Promise<AccessVerdict> | AccessVerdict

  /** Observe access decisions. Errors here are logged, never propagated. */
  onEvent?: (event: RegistryEvent) => void | Promise<void>
}

/** Parse `REGISTRY_PLUGINS` into module specifiers. */
export function pluginSpecifiers(env: Record<string, string | undefined> = process.env): string[] {
  return (env.REGISTRY_PLUGINS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
}

function assertPlugin(value: unknown, specifier: string): RegistryPlugin {
  if (!value || typeof value !== 'object' || typeof (value as RegistryPlugin).name !== 'string') {
    throw new TypeError(
      `Registry plugin "${specifier}" must default-export an object with a \`name\` (or a function returning one)`,
    )
  }
  return value as RegistryPlugin
}

/** Import one plugin module. Exported for tests and for programmatic embedding. */
export async function loadPlugin(specifier: string): Promise<RegistryPlugin> {
  // Relative specifiers are relative to where the operator started the server,
  // not to this file — `./plugins/x.ts` should mean what it says on the tin.
  const target = specifier.startsWith('.')
    ? new URL(specifier, `file://${process.cwd()}/`).href
    : specifier

  let mod: { default?: unknown }
  try {
    mod = await import(target) as { default?: unknown }
  }
  catch (err) {
    throw new Error(`Failed to load registry plugin "${specifier}": ${(err as Error).message}`)
  }

  const exported = mod.default
  const resolved = typeof exported === 'function' ? await (exported as () => unknown)() : exported
  return assertPlugin(resolved, specifier)
}

let _plugins: Promise<RegistryPlugin[]> | null = null

/**
 * Load every configured plugin once per process. The promise is cached, so the
 * request path pays a resolved-promise await and nothing more.
 */
export function loadPlugins(env: Record<string, string | undefined> = process.env): Promise<RegistryPlugin[]> {
  if (_plugins) return _plugins

  const specifiers = pluginSpecifiers(env)
  _plugins = specifiers.length === 0
    ? Promise.resolve([])
    : Promise.all(specifiers.map(loadPlugin)).then((plugins) => {
      console.log(`Loaded ${plugins.length} registry plugin(s): ${plugins.map(p => p.name).join(', ')}`)
      return plugins
    })

  return _plugins
}

/** Replace the loaded set — for tests and for embedding the registry as a library. */
export function setPlugins(plugins: RegistryPlugin[]): void {
  _plugins = Promise.resolve(plugins)
}

/** Forget the loaded set so the next call re-reads `REGISTRY_PLUGINS`. */
export function resetPlugins(): void {
  _plugins = null
}

/**
 * Whether any loaded plugin decides access. Lets the gate skip resolving the
 * caller's identity on a public registry with no policy plugins, which is the
 * hot path on a busy public deployment — one token lookup per request that
 * nothing would have looked at.
 */
export async function pluginsAuthorize(): Promise<boolean> {
  const plugins = await loadPlugins()
  return plugins.some(p => typeof p.authorizeRead === 'function')
}

/**
 * Ask every plugin about a read request. `'deny'` wins over `'allow'`; if no
 * plugin has an opinion the caller falls back to the built-in credential check.
 */
export async function pluginAccessVerdict(ctx: AccessRequest): Promise<AccessVerdict> {
  const plugins = await loadPlugins()
  let verdict: AccessVerdict

  for (const plugin of plugins) {
    if (!plugin.authorizeRead) continue
    let result: AccessVerdict
    try {
      result = await plugin.authorizeRead(ctx)
    }
    catch (err) {
      // A policy that throws must not fail open.
      console.error(`Registry plugin "${plugin.name}" authorizeRead threw:`, err)
      return 'deny'
    }
    if (result === 'deny') return 'deny'
    if (result === 'allow') verdict = 'allow'
  }

  return verdict
}

/** Give plugins a chance to serve the request themselves. */
export async function pluginResponse(req: Request, ctx: PluginContext): Promise<Response | null> {
  const plugins = await loadPlugins()

  for (const plugin of plugins) {
    if (!plugin.handleRequest) continue
    try {
      const res = await plugin.handleRequest(req, ctx)
      if (res) return res
    }
    catch (err) {
      console.error(`Registry plugin "${plugin.name}" handleRequest threw:`, err)
      return Response.json({ error: 'Plugin error' }, { status: 500 })
    }
  }

  return null
}

/** Fire-and-forget notification. Never throws, never blocks the response. */
export function emitPluginEvent(event: RegistryEvent): void {
  void loadPlugins().then((plugins) => {
    for (const plugin of plugins) {
      if (!plugin.onEvent) continue
      try {
        const result = plugin.onEvent(event)
        if (result && typeof (result as Promise<void>).catch === 'function')
          (result as Promise<void>).catch(err => console.error(`Registry plugin "${plugin.name}" onEvent rejected:`, err))
      }
      catch (err) {
        console.error(`Registry plugin "${plugin.name}" onEvent threw:`, err)
      }
    }
  }).catch(() => { /* plugin loading already reported at boot */ })
}
