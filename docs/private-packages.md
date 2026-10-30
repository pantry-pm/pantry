# Private packages

A private package lives on a public registry and is invisible to everyone you
haven't let in. It is how you ship a kit, SDK or internal library to specific
customers without giving them your source repository and without standing up a
registry of your own.

Private is per package. The registry around it stays public, and your other
packages stay public. That is the difference from a
[private registry](self-hosting.md), which closes the whole server: there every
request needs a credential, but any member can read every package. A private
package keeps even members out unless they were granted it, so the two stack: on
a private registry, a private package is still visible only to its grants.

## Who can see a private package

| Who | How |
|-----|-----|
| The owner | The account that first published it |
| The owner's team | Members of the owner's [team](paid-packages.md#teams) |
| Admins | The registry token, or a signed-in admin |
| Granted accounts | An account the owner granted, until the grant expires |
| Granted teams | Every member of a team whose seat holder was granted |
| Package tokens | A read-only token the owner minted for this one package |

Everyone else, signed in or not, gets exactly the response a package that was
never published gets. The metadata, the version list, a version, the tarball,
the package page, badges, download stats and commit snapshots all return the
same `404` and the same body. Search, the top-packages lists and the stats
pages leave the package out. Nothing in a response tells a stranger the package
exists.

## Making a package private

### When you publish

Use npm's `publishConfig` convention in `pantry.json` or `package.json`:

```json
{
  "name": "@acme/platform",
  "version": "1.0.0",
  "publishConfig": { "access": "restricted" }
}
```

```bash
pantry publish
```

The registry reads `publishConfig.access` from the metadata the CLI sends and
from the manifest inside the tarball. If either one says `restricted`, the
package is private. It is private from its very first write, so there is no
moment when it is visible.

`publishConfig` only counts on the **first** publish. After that a package keeps
its visibility:

- a later publish with `"access": "public"` does **not** make a private package
  public, so a manifest copied from an open-source sibling can't leak it;
- a later publish with `"access": "restricted"` does **not** make a public
  package private, because its versions have already been served.

Only the settings change visibility once a package exists. A publish response
includes `"visibility"`, so CI can confirm what it published.

### From the package settings

In the publisher dashboard (**Publisher → package → Visibility**), choose
**Private**. The same setting is `PATCH /publisher/api/packages/{name}` with
`{"settings": {"visibility": "private"}}`, using a signed-in session. Choose
**Public** to open the package again.

### Plans

Private packages are a paid-plan feature, like unlisted ones. Pro and Team
include them; Free doesn't:

| | Free | Pro | Team |
|---|---|---|---|
| Private & unlisted packages | — | ✓ | ✓ |

A restricted publish from an account without the feature is **refused** with
`402`, and nothing is published. Publishing the package publicly instead would
do exactly what the author said not to. The plan that counts is the seat
holder's, so a Team member publishes private packages on the team's plan. The
registry operator (registry token or admin session) is exempt.

A package stays private if its owner's plan lapses. The registry never makes a
package public on its own. Grants and package tokens can still be managed, so
access can always be revoked.

## Granting access

```bash
pantry access list   @acme/platform
pantry access grant  @acme/platform it@client.example --expires-in-days 90
pantry access revoke @acme/platform it@client.example
```

Grant an account by email. The grant works whether or not that person has an
account yet: when they sign up with that address and create a token, they can
install. Leave out `--expires-in-days` for a grant that never expires;
otherwise it takes 1 to 3650 days.

Over HTTP:

```bash
# Grant
curl -X PUT https://registry.pantry.dev/packages/%40acme%2Fplatform/access \
  -H "Authorization: Bearer $PANTRY_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"email":"it@client.example"}'

# Grant until a date (ISO 8601, in the future)
curl -X PUT https://registry.pantry.dev/packages/%40acme%2Fplatform/access \
  -H "Authorization: Bearer $PANTRY_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"email":"it@client.example","expiresAt":"2027-06-30T00:00:00Z"}'

# Who has access
curl https://registry.pantry.dev/packages/%40acme%2Fplatform/access \
  -H "Authorization: Bearer $PANTRY_TOKEN"

# Revoke
curl -X DELETE https://registry.pantry.dev/packages/%40acme%2Fplatform/access \
  -H "Authorization: Bearer $PANTRY_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"email":"it@client.example"}'
```

A `PUT` for an account that already has a grant updates its expiry and keeps
the original grant date. Send `"expiresAt": null` to make it permanent again.

**Grant a team by granting its seat holder.** A grant to the account that owns a
team covers every member of that team, and covers new members as they join.
This is the same rule [paid packages](paid-packages.md#teams) use: the team gets
access once, and someone who leaves the team loses it.

Grants share storage with purchases. A buyer of a paid package and a client
granted a private one hold the same kind of entitlement, so a grant also lets
its holder past a price. The access list shows purchases too, and revoking one
removes that buyer's access.

## Package tokens for CI

A client's CI usually shouldn't hold a person's credentials. Mint a token that
can read this one package and nothing else:

```bash
pantry access token @acme/platform --name client-ci --expires-in-days 365
# Issued package token "client-ci" for @acme/platform (id ptry_1a2…9f0e, expires …).
# It is shown once:
#
#   ptry_…
```

Over HTTP:

```bash
curl -X POST https://registry.pantry.dev/packages/%40acme%2Fplatform/tokens \
  -H "Authorization: Bearer $PANTRY_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"client-ci","expiresInDays":365}'
# {"token":"ptry_…","id":"ptry_1a2…9f0e","name":"client-ci","expiresAt":"2027-10-30T…"}
```

The token is shown once, and the registry keeps only a hash. Hand it to the
client, who stores it like any other registry token: `pantry token set`, or
`PANTRY_REGISTRY_TOKEN` in CI secrets:

```bash
echo 'ptry_…' | gh secret set PANTRY_REGISTRY_TOKEN --repo client/app
```

A package token:

- reads metadata, versions and tarballs of **its package only**, including past
  a price on that package;
- cannot read any other private package, publish anything, manage access, sign
  in, buy, subscribe or use any account feature. It isn't an account, so
  everything that needs one refuses it;
- works on a registry that is private as a whole, but only for reads of its own
  package;
- belongs to the package rather than to whoever minted it, so it keeps working
  when that person leaves the team;
- stops working when it expires or is revoked.

```bash
pantry access tokens       @acme/platform                # id, name, expiry, last used
pantry access token-revoke @acme/platform ptry_1a2…9f0e  # the next install with it is refused

# Or over HTTP. List (no secrets)
curl https://registry.pantry.dev/packages/%40acme%2Fplatform/tokens \
  -H "Authorization: Bearer $PANTRY_TOKEN"

# Revoke
curl -X DELETE "https://registry.pantry.dev/packages/%40acme%2Fplatform/tokens/ptry_1a2...9f0e" \
  -H "Authorization: Bearer $PANTRY_TOKEN"
```

`expiresInDays` is optional, from 1 to 3650. Without it the token doesn't
expire, so prefer setting one.

### Who can manage access

Every `pantry access` command authenticates the way `pantry publish` does:
`--token`, then `PANTRY_REGISTRY_TOKEN` / `PANTRY_TOKEN`, then the credential
`pantry token set` stored for the registry. The registry is `--registry`, else
`PANTRY_REGISTRY_URL`, else registry.pantry.dev.

| Response | Meaning |
|---|---|
| `401` | The token isn't accepted for management. A read-only or package token can install, but it can't change access. |
| `403` | You can install the package, but only its publisher (or their team) can change who has access. |
| `404` | No such package, or it's private and this account can't see it. Revoking a grant or token that doesn't exist also returns `404`. |

## Installing: pin the scope

In the consuming project:

```json
{
  "scopes": { "@acme": "pantry" },
  "dependencies": { "@acme/platform": "^1.4.0" }
}
```

```bash
PANTRY_REGISTRY_TOKEN=ptry_… pantry install
```

The scope's value is `"pantry"`, meaning the Pantry registry this machine uses
(`PANTRY_REGISTRY_URL`, else registry.pantry.dev). It can also be the URL of
another Pantry-protocol registry, such as `"https://registry.acme.example"`. In a
`package.json`, put the same object under `"pantry": { "scopes": { … } }`.

For every package in a pinned scope:

- **The Pantry registry is the only source.** Pantry never asks npm, pkgx or any
  other registry about the name, at the top level or deep in the tree. This is
  what stops dependency confusion: if someone publishes `@acme/platform` on npm,
  your install doesn't pick it up when the private lookup fails.
- **Versions resolve by semver from the registry's version list**
  (`GET /packages/{name}/versions`). Exact pins (`1.4.0`), ranges (`^1.4.0`,
  `~1.4`, `>=1.2 <2`, `1.x`, `||`) and `latest` all work. A version
  `pantry.lock` already records wins while it still satisfies the range.
- **Metadata, the version list and the tarball all carry the token.**
- **`pantry.lock` records `integrity: "sha256:<hex>"`**, from the registry's
  checksum (or from the downloaded bytes if the registry sent none). Later
  installs check the tarball against it. If the registry's checksum for a
  locked version changes, the install stops.
- **Every failure stops the install** and says what to do:

  ```
  - @acme/platform@1.4.0 (@acme/platform@1.4.0 is not available from
    registry.pantry.dev (404). It is private: set PANTRY_REGISTRY_TOKEN to a
    token with access. @acme is pinned to registry.pantry.dev in "scopes";
    no other registry was tried.)
  ```

  The registry shows someone without access an empty version list for a private
  package, the same as a name that was never published. Pantry reports both the
  same way.

A malformed `scopes` entry (a key that isn't `@scope`, or a value that isn't
`"pantry"` or an http(s) URL) also stops the install. Skipping it would turn the
scope back into one that resolves from npm.

### Tokens for a custom scope registry

When `scopes` names a URL, requests to that registry carry, in this order:

1. a credential stored for exactly that registry:
   `pantry token set --registry https://registry.acme.example`
2. `PANTRY_REGISTRY_TOKEN`, then `PANTRY_TOKEN`, from the environment

The global (unscoped) entry in `~/.pantry/credentials` is never sent to a URL
that came from a project's manifest. Over plain `http://`, a token is only sent
to `localhost` / `127.0.0.1`. Keep in mind that the environment token is sent to
whatever URL a repository's `scopes` names. On CI that builds untrusted pull
requests, use a package token (read-only, one package) rather than a broad
account token.

## Without scopes

If a name isn't pinned, Pantry keeps its usual order: the Pantry registry, then
npm. There's one exception. When the Pantry registry answers `401`, `402` or
`403` for a name, the name is Pantry's and needs a credential or a purchase, so
the install stops there and doesn't try npm. A `404` or an unreachable registry
still falls back to npm, so public installs don't depend on Pantry being up.

An exact version (`pantry install left-pad@1.2.0`) is looked up on the Pantry
registry as that exact version. A range only accepts a Pantry answer that
satisfies it.

## API

`{name}` may be URL-encoded (`%40acme%2Fplatform`) or raw (`@acme/platform`).

| Endpoint | Body | Response |
|----------|------|----------|
| `GET /packages/{name}/access` | | `{ grants: [{ subject, email?, name?, expiresAt, createdAt }] }` |
| `PUT /packages/{name}/access` | `{ email, expiresAt? }` | `200 { grant }` |
| `DELETE /packages/{name}/access` | `{ email }` | `200 { revoked: true }`, or `404` if there was no grant |
| `POST /packages/{name}/tokens` | `{ name, expiresInDays? }` | `201 { token, id, name, expiresAt }` |
| `GET /packages/{name}/tokens` | | `{ tokens: [{ id, name, expiresAt, createdAt, lastUsedAt? }] }` |
| `DELETE /packages/{name}/tokens/{id}` | | `200 { revoked: true }`, or `404` |

`subject` is `user:<email>` for an account grant and `token:<id>` for a package
token, so the access list shows both. `expiresAt` is `null` when access doesn't
expire.

These endpoints accept the owner or a member of the owner's team (an API token
with `publish` permission, or a session), or an admin (the registry token or an
admin session). A read-only token can install but can't hand out access.

- Anyone who can't see a private package gets the same `404` as for a package
  that doesn't exist.
- Someone who can see it (a granted account, say) but doesn't own it gets `403`.
- A private package published with the registry token has no owner, so only
  admins manage it.

## Caching

Responses for a private package carry `Cache-Control: private, no-store`, so a
CDN never stores one and serves it to someone else. The shared, cached pages
(search, home, stats, compare) never include private packages, for anyone,
because they're cached for everyone.

## Limits

- **Existence on publish.** A stranger who tries to publish a version under a
  private package's name is told the name belongs to another account, the same
  as for any taken name. Name ownership is first-come, so publishing is the one
  place a name's existence shows.
- **Shared caches and the not-found answer.** A refused caller gets the same
  answer as for a missing package, including its caching headers. A shared cache
  that ignores `Authorization` could keep that answer for up to a minute and
  show it to someone who does have access. Send credentials to the registry
  directly, or configure the cache to vary on `Authorization`.
- **npm fallback.** A caller who can't see a private package gets a plain `404`.
  The registry never falls back to npm for that name, which would hand them
  someone else's package under your name.
- **Zig, PHP and system packages** have their own namespaces and aren't covered.
  Private applies to registry packages published with `pantry publish`.
