# Extending the registry

A self-hosted registry is a Bun process you own, so you can always edit
`packages/registry/src/server.ts`. The problem with doing that is the next
upstream pull: your change and ours land in the same 4,000-line file, forever.

Plugins are the seam that avoids it. Your code lives in your own file or your
own package, the registry loads it at boot, and `git pull` stays boring.

```bash
# in the registry's environment file
REGISTRY_PLUGINS=./plugins/access.ts,@acme/pantry-audit
```

Relative specifiers resolve against the registry's working directory
(`packages/registry` in the standard deployment). Each module default-exports a
plugin object, or a function returning one — sync or async — so a plugin can
read its own configuration at startup.

## The interface

```ts
import type { RegistryPlugin } from '@stacksjs/registry'

export default {
  name: 'acme',

  // Serve a request yourself. Runs before the registry's own routes, so you can
  // add endpoints or override built-in ones. Return null to pass.
  handleRequest(req, ctx) { return null },

  // Decide whether a read is allowed: 'allow', 'deny', or undefined to defer.
  authorizeRead(ctx) { return undefined },

  // Observe access decisions. Errors here are logged, never propagated.
  onEvent(event) {},
} satisfies RegistryPlugin
```

### `authorizeRead(ctx) → 'allow' | 'deny' | undefined`

Called for every request, on public and private registries alike.

- `'allow'` — serve it, **skipping** the built-in credential check.
- `'deny'` — refuse it, even if the caller holds a valid token. Answered as
  `403`.
- `undefined` — no opinion; fall through to the next plugin, then to the
  built-in check.

`'deny'` from any plugin beats `'allow'` from another, and a plugin that throws
is treated as `'deny'`. Policies compose by intersection, so adding one can
never widen access by accident.

`ctx` carries the request, the parsed `url`, `path`, `method`, the registry's
`visibility`, and `userId` — the identity the built-in check resolved: a user
email, `_admin` for the shared registry token, or `null` for an anonymous
caller. That last field is what lets you layer policy on top of identity instead
of reimplementing authentication.

### `handleRequest(req, ctx) → Response | null`

Runs **after** the access gate, so on a private registry your route only sees
authenticated callers unless its path is listed in `REGISTRY_PUBLIC_PATHS`.
Return `null`/`undefined` to let the registry handle the request.

### `onEvent(event)`

Fire-and-forget notification of access decisions:

```ts
{ type: 'access-granted', path, method, userId }
{ type: 'access-denied',  path, method, reason }
```

`access-granted` fires when a gated request passed the credential check —
requests to paths that are open anyway don't produce an event, so an audit log
records access to protected things rather than every hit on `/health`. It never
blocks the response and never fails a request.

## Worked examples

### Publish one package publicly from a private registry

```ts
// plugins/public-sdk.ts
import type { RegistryPlugin } from '@stacksjs/registry'

const PUBLIC = ['/packages/@acme/sdk', '/binaries/acme.com']

export default {
  name: 'public-sdk',
  authorizeRead: ctx => PUBLIC.some(p => ctx.path.startsWith(p)) ? 'allow' : undefined,
} satisfies RegistryPlugin
```

(For a static list of prefixes you don't need a plugin at all —
`REGISTRY_PUBLIC_PATHS` does the same thing. Reach for code when the rule is
dynamic.)

### Restrict downloads to the office network

```ts
// plugins/ip-allowlist.ts
import type { RegistryPlugin } from '@stacksjs/registry'

const ALLOWED = (process.env.ACME_ALLOWED_CIDRS || '').split(',').filter(Boolean)

export default () => ({
  name: 'ip-allowlist',
  authorizeRead(ctx) {
    // Behind a proxy, trust only the header your proxy actually sets.
    const ip = ctx.req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    if (!ip) return 'deny'
    return ALLOWED.some(cidr => inCidr(ip, cidr)) ? undefined : 'deny'
  },
}) satisfies () => RegistryPlugin
```

Returning `undefined` rather than `'allow'` on the happy path matters: the
request still has to pass the token check. The plugin narrows access, it doesn't
replace authentication.

### Per-team package access

```ts
// plugins/teams.ts
import type { RegistryPlugin } from '@stacksjs/registry'

const TEAMS: Record<string, string[]> = {
  '@acme/payments': ['payments@acme.com', 'sre@acme.com'],
}

export default {
  name: 'teams',
  authorizeRead(ctx) {
    const match = ctx.path.match(/^\/packages\/(@[^/]+\/[^/]+)/)
    const owners = match && TEAMS[decodeURIComponent(match[1])]
    if (!owners) return undefined                    // not a restricted package
    if (ctx.userId === '_admin') return undefined    // operators keep access
    return owners.includes(ctx.userId ?? '') ? undefined : 'deny'
  },
} satisfies RegistryPlugin
```

### Ship an audit trail

```ts
// plugins/audit.ts
import type { RegistryPlugin } from '@stacksjs/registry'

export default {
  name: 'audit',
  onEvent(event) {
    if (event.type !== 'access-denied') return
    void fetch(process.env.ACME_SLACK_WEBHOOK!, {
      method: 'POST',
      body: JSON.stringify({ text: `Denied ${event.method} ${event.path}: ${event.reason}` }),
    }).catch(() => {})
  },
} satisfies RegistryPlugin
```

### Add an endpoint

```ts
// plugins/routes.ts
import type { RegistryPlugin } from '@stacksjs/registry'

export default {
  name: 'routes',
  handleRequest(req, ctx) {
    if (ctx.path !== '/api/teams') return null
    return Response.json({ teams: ['core', 'payments'] })
  },
} satisfies RegistryPlugin
```

## Failure behaviour

Load failures are **fatal**: a plugin that can't be imported, or doesn't export
an object with a `name`, stops the registry from starting. A registry running in
private mode with a half-loaded access policy is worse than one that refuses to
boot, and a service that won't start is a page — a policy that silently isn't
running is a breach nobody notices.

At request time the failure modes are the safe ones: a throwing `authorizeRead`
denies, a throwing `handleRequest` answers `500`, and a throwing `onEvent` is
logged and ignored.

## Testing a plugin

The plugin registry is swappable, so you can exercise policy against a real
server without touching the filesystem:

```ts
import { createServer, setPlugins } from '@stacksjs/registry'

setPlugins([{ name: 'test', authorizeRead: () => 'deny' }])
// … start a server, assert the 403 …
```

`packages/registry/src/access.test.ts` does exactly this; it's the shortest
route to a working example.

## Beyond plugins

Some extensions aren't request-shaped. Those are ordinary code changes in your
fork, and the interfaces are already narrow:

- **Storage** — implement `TarballStorage` / `MetadataStorage`
  (`packages/registry/src/types.ts`) for a backend that isn't S3-compatible.
  Selection lives in `storage/provider.ts`.
- **Auth backend** — implement `AuthStorage` to keep users and tokens in your
  own directory service. `createAuthStorage()` picks the implementation.
- **Upstream fallbacks** — `npm-fallback.ts`, `packagist-fallback.ts` and
  `pkgx-fallback.ts` show the pattern for proxying another ecosystem.

If you build something the seams don't reach, that's worth an issue: a hook we
add upstream is a hook you stop maintaining.
