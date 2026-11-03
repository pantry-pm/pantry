# Registry tokens

A pantry registry token authenticates everything you publish: packages, commit
releases, native binaries, and the build events that feed the dashboard. This
page is how to get one, where to put it, and which kind does what.

It is about the **pantry registry** (`registry.pantry.dev`, or your own).
Publishing JavaScript to **npm** is a separate credential — see
[Publishing to npm](/NPM_OIDC_PUBLISHING).

## Mint one

Signups are open on `registry.pantry.dev`. On a private registry they are
closed, and an operator creates the account for you (see
[Issue one for somebody else](#issue-one-for-somebody-else)).

1. Sign up at `https://registry.pantry.dev/signup`, or sign in at `/login`.
2. Open `https://registry.pantry.dev/account` and choose **Create token**.
3. Give it a name, the permissions it needs, and an expiry.
4. **Copy the value straight away.** Only a hash is stored, so the page never
   shows it again — afterwards you see a masked id such as `ptry_abc1...wxyz`,
   which is what you use to revoke it.

A token is a secret in the ordinary sense: anything holding it can publish as
you until it expires or is revoked.

## Store it

`pantry token set` writes to `~/.pantry/credentials`, which publishing already
read but nothing could write:

```sh
pantry token set            # reads the value from stdin
```

Prefer stdin over `--value`: an argument is visible to every other process on
the machine while the command runs.

```sh
op read op://vault/pantry/token | pantry token set
pantry token list           # what is configured, masked, and where from
pantry token get            # print it, for piping
pantry token rm             # remove it
```

Keys written before any `[registry-url]` section apply to every registry, so a
flat file keeps working. A scoped entry wins over a global one, which is what
lets a private registry and the public one hold different tokens:

```sh
pantry token set --registry https://registry.example.com
```

## Put it in CI

```sh
pantry token sync --repo owner/name
```

This copies the credential into that repository's Actions secrets as
`PANTRY_TOKEN`, handing the value to `gh` on stdin so it never reaches the
process table. `--secret` renames the secret; `--registry` picks which scoped
credential to send. It needs the [GitHub CLI](https://cli.github.com) because
that is what encrypts the secret before upload. The equivalent by hand:

```sh
pantry token get | gh secret set PANTRY_TOKEN --repo owner/name
```

In a workflow, both names are read everywhere, `PANTRY_REGISTRY_TOKEN` first:

```yaml
env:
  PANTRY_REGISTRY_TOKEN: ${{ secrets.PANTRY_TOKEN }}
```

Any job running `build-all-packages.ts` needs this, or its builds compile fine
and are invisible on the dashboard — every build event `POST`s a 401 and
reporting is deliberately fire-and-forget, so nothing fails loudly.

## What each kind can do

| Kind | Mint it with | Can |
| --- | --- | --- |
| Account token | `/account`, or `pantry registry token issue` | Publish and read packages and commit releases |
| Read-only token | same, permissions `read` | Download from a private registry |
| Package token | `POST /packages/{name}/tokens` | Read exactly one package, nothing else |
| Native grant | `pantry registry token issue --publish --binary-domain` | Publish binaries for named domains |
| Operator token | the registry's own `PANTRY_REGISTRY_TOKEN` | Everything, including `/admin` |

The distinction that catches people: **an account token publishes packages, not
binaries.** `POST /api/v1/binaries/uploads` admits the operator token or a token
carrying that exact domain in `binaryPublishDomains`, and the self-serve route
refuses to issue one — `POST /auth/tokens` answers 403, *"Native package grants
can only be issued by a registry operator"*. If you are uploading system
packages or apps and seeing 401s with a token that publishes fine otherwise,
this is why.

## Issue one for somebody else

Operator-side, against a registry you run. These are HTTPS calls to the
registry's API and need the admin credential stored for that registry:

```sh
pantry registry member add dev@yourco.com --name "Dev" --password '…'
pantry registry token issue dev@yourco.com --name laptop
pantry registry token issue ci@yourco.com --name ci --publish --expires-in-days 90
```

Read-only unless you pass `--publish`. To grant native publication, name the
exact domain — it requires `--publish`, and the flag takes one domain. The API
accepts between 1 and 20 per token, so a token covering several needs
`POST /admin/tokens` with a `binaryPublishDomains` array rather than this
command:

```sh
pantry registry token issue ci@yourco.com --name ci --publish \
  --binary-domain example.com
```

Revoke by the id shown when it was issued:

```sh
pantry registry token revoke dev@yourco.com --id ptry_abc1...wxyz
```

## Rotating

`pantry registry rotate-token` replaces the shared operator token on a registry
you run — it reaches the box over SSH, so it needs `--host` and the rest of the
connection flags. It mints the replacement, waits until the registry actually
accepts it, and only then updates CI — so a failed rotation leaves
publishing working on the old token rather than stranding it:

```sh
pantry registry rotate-token --repos "owner/name,owner/other"
```

Without `--repos` it rotates and prints the new value, updating no secrets.

## When something returns 401

- `pantry token list` — is a credential configured at all, and is it the one
  scoped to the registry you are publishing to?
- Did the token expire, or was it revoked? The id in `/account` outlives the
  value, so a revoked token looks identical from the client side.
- Is it the right *kind*? A read-only or package-scoped token authenticates
  fine and still cannot publish. A publish token still cannot upload binaries
  without a native grant.
- In CI, is the secret present under a name the tooling reads —
  `PANTRY_REGISTRY_TOKEN`, `PANTRY_TOKEN`, or `PANTRY_BUILD_REPORT_TOKEN` for
  build reporting alone?
