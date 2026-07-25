# Run your own registry

Everything the public registry runs on is in this repo. Fork it, point the
scripts at your own box, and you have a registry for your own packages — no
part of the deployment depends on the maintainers' infrastructure.

Two shapes, one process:

- **Public** — anyone can resolve and download; publishing needs a token. This
  is what `registry.pantry.dev` runs, and it's the default.
- **Private** — nothing is served without a credential. Metadata, tarballs,
  binaries, search and the web UI all require an API token or a logged-in
  session. One environment variable away from the above.

For the API surface and storage guarantees, see
[the registry contract](registry.md).

## Quick start

One command, from your workstation, against a fresh Linux box you can SSH into:

```bash
PANTRY_REGISTRY_HOST=registry.example.com \
PANTRY_REGISTRY_REPO=https://github.com/you/your-fork \
STORAGE_PROVIDER=hetzner \
S3_BUCKET=my-registry \
S3_REGION=fsn1 \
S3_ACCESS_KEY_ID=… \
S3_SECRET_ACCESS_KEY=… \
  ./scripts/setup-private-registry.sh
```

That installs Bun, clones your fork, writes the service environment, installs
and starts the systemd unit, configures object storage, generates a registry
token, and then proves the result from the outside: an anonymous read must come
back `401`, an authenticated one must not. It finishes by printing your token
and the exact commands to publish, install, and add a teammate.

It is idempotent. Re-run it to upgrade the checkout, change storage, or move
between public and private (`--public` / `--private`). Your token is kept unless
you pass `--rotate-token`.

You still need two things it deliberately doesn't do:

- **TLS.** Put Caddy, nginx or rpx in front of the port. The script prints a
  two-line Caddyfile that does it.
- **A private bucket.** Keep object storage private; the registry proxies
  `…/binaries/…` itself, so the bucket never needs to be public.

Prefer to do it by hand, or deploying somewhere systemd isn't? See
[Manual setup](#manual-setup) — the registry is a Bun process reading an
environment file, and nothing about it requires this script.

## What "private" means

`REGISTRY_VISIBILITY=private` closes reads. The gate runs before routing, as an
allowlist of what stays open, so a route added to the registry later is private
by default rather than by someone remembering to gate it.

| Path | Public registry | Private registry |
|------|-----------------|------------------|
| `GET /health` | open | open |
| `GET /api/registry-info` | open | open |
| `/login`, `/signup`, `/auth/login`, `/auth/logout`, `/auth/me` | open | open |
| `GET /packages/…`, `/commits/…`, `/zig/…`, `/php/…` | open | **credential required** |
| `GET /binaries/…` (system packages, apps) | open | **credential required** |
| `GET /search`, the web UI, the dashboard | open | **credential required** |
| `POST /publish`, `/admin/…` | token | token |

A credential is any of:

- a **user API token** (`ptry_…`) with `read` or `publish` permission —
  `publish` implies `read`, so one CI token can both upload a version and ask
  which versions exist;
- the **shared registry token** (`PANTRY_REGISTRY_TOKEN`), which is also the
  admin credential;
- a **logged-in browser session**, so the web UI works for signed-in humans.

Anything else gets `401` with a `WWW-Authenticate` header and a hint naming the
command that fixes it. A browser navigating to a gated page is sent to `/login`
instead — a JSON error is not a useful thing to show a person.

Signups are **closed by default on a private registry** — a private registry
anyone can sign up to isn't private. Members are provisioned by an operator (see
below), or you can re-open self-serve signup and restrict it to your own email
domains:

```bash
REGISTRY_ALLOW_SIGNUP=true
REGISTRY_SIGNUP_DOMAINS=yourco.com,yourco.dev
```

Clients discover all of this without a credential:

```bash
curl https://registry.example.com/api/registry-info
# {"visibility":"private","requiresAuth":true,"signupsEnabled":false,…}
```

## Members and tokens

Open signup is off, so onboarding goes through the admin endpoints. They accept
the shared registry token (what your provisioning scripts and CI already have)
or an admin session — a plain publish token can't mint access.

Create an account:

```bash
curl -X POST https://registry.example.com/admin/users \
  -H "Authorization: Bearer $PANTRY_REGISTRY_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"email":"dev@yourco.com","name":"Dev","password":"a-long-password"}'
```

Pass `"role":"admin"` to make them an operator. Re-running with a new password
resets it.

Members can then log in at `https://registry.example.com/login` and manage their
own tokens from `/account`. For machines — CI, a build box, a container image —
mint the token directly and hand over only what it needs:

```bash
curl -X POST https://registry.example.com/admin/tokens \
  -H "Authorization: Bearer $PANTRY_REGISTRY_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"email":"dev@yourco.com","name":"ci","permissions":["read"],"expiresInDays":90}'
# → {"token":"ptry_…","info":{"id":"ptry_abc…wxyz",…}}
```

The raw token is shown once; only its SHA-256 is stored. Revoke it by id:

```bash
curl -X POST https://registry.example.com/admin/tokens/revoke \
  -H "Authorization: Bearer $PANTRY_REGISTRY_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"email":"dev@yourco.com","id":"ptry_abc…wxyz"}'
```

Revocation takes effect immediately — the next download with that token is
`401`.

Rotate the shared registry token with
[`./scripts/rotate-registry-token.sh`](../scripts/rotate-registry-token.sh),
which updates the server first and only touches GitHub secrets once the live
registry accepts the new value, so a failed server update can't leave CI holding
a token the server rejects.

## Installing from your registry

Two things point a machine at your registry: where it is, and the credential.

```bash
export PANTRY_REGISTRY_URL=https://registry.example.com
echo 'ptry_…' | pantry token set --registry https://registry.example.com
pantry install
```

`PANTRY_REGISTRY_URL` redirects registry traffic to your host; the stored
credential is attached as `Authorization: Bearer …` on every request that goes
there. Tokens are only ever sent to a registry you have named — either the
origin matches `PANTRY_REGISTRY_URL`, or `~/.pantry/credentials` holds an entry
scoped to exactly that origin. A stray `PANTRY_TOKEN` in your environment is
never broadcast to npm, GitHub, or the object-storage host a download redirects
to. (curl drops `Authorization` across a cross-host redirect, which is exactly
what a presigned download URL is.)

The credentials file makes several registries coexist, which is what you want
when your own packages are private but everything else comes from the public
registry:

```ini
# ~/.pantry/credentials — written by `pantry token set`, mode 0600
PANTRY_TOKEN=ptry_public_default

[https://registry.example.com]
PANTRY_TOKEN=ptry_private_read_only
```

In CI, the token is a secret and the URL is a plain variable:

```yaml
- uses: pantry-pm/pantry/packages/action@main
- run: pantry install
  env:
    PANTRY_REGISTRY_URL: https://registry.example.com
    PANTRY_REGISTRY_TOKEN: ${{ secrets.PANTRY_TOKEN }}
```

`pantry token sync --repo you/app --registry https://registry.example.com`
copies a stored credential into a repository's Actions secrets, so you don't
paste tokens into the GitHub UI.

If a token is missing or wrong, the CLI says so during install rather than
reporting a generic network failure:

```
HTTP 401 from https://registry.example.com/binaries/… — this registry requires authentication.
Store a token with: pantry token set --registry <registry-url>
```

## Publishing to it

```bash
echo 'ptry_…' | pantry token set --registry https://registry.example.com
pantry publish --registry https://registry.example.com
```

The credential is scoped to that registry, so publishing to a different one
still uses its own token. For CI:

```bash
pantry token sync --repo you/app --registry https://registry.example.com
```

## Opening part of a private registry

Sometimes one package should be readable by anyone — a public SDK next to your
internal packages, or an install script you `curl | bash`:

```bash
REGISTRY_PUBLIC_PATHS=/,/packages/@acme/sdk
```

Each entry is a path prefix; a bare `/` means only the root path, not
everything. For policy more interesting than a prefix list — per-team access, an
IP allowlist, SSO — write a plugin.

## Extending it

A fork can edit `packages/registry/src/server.ts`, but then every upstream pull
is a merge conflict. Plugins are the seam that avoids that: your code lives in
your own file or package, and the registry loads it at boot.

```bash
REGISTRY_PLUGINS=./plugins/access.ts,@acme/pantry-audit
```

A plugin can add routes, decide access (including overruling the built-in
check), and observe every access decision for an audit log. See
[Extending the registry](registry-extensions.md) for the API and worked
examples.

## Manual setup

The script above does all of this; this is what it does, for when you'd rather
do it yourself or you're deploying somewhere else entirely.

### 1. Provision the box

```bash
curl -fsSL https://bun.sh/install | bash

install -d /opt/pantry-registry
git clone https://github.com/<you>/<your-fork> /opt/pantry-registry/repo
cd /opt/pantry-registry/repo && bun install
```

Create the environment file the service reads. Keep it `0600` — it holds your
storage credentials and registry token:

```bash
install -m 600 /dev/null /opt/pantry-registry/registry.env
cat > /opt/pantry-registry/registry.env <<'EOF'
PORT=3000
BASE_URL=https://registry.example.com
REGISTRY_VISIBILITY=private
EOF
```

Then a systemd unit. Note it loads the environment from that file rather than
carrying `Environment=` lines — the scripts below write to the file, and mixing
the two means whichever systemd applies last silently wins:

```ini
# /etc/systemd/system/pantry-registry.service
[Unit]
Description=Pantry Registry
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/pantry-registry/repo/packages/registry
EnvironmentFile=/opt/pantry-registry/registry.env
ExecStart=/root/.bun/bin/bun run src/server.ts
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload && systemctl enable --now pantry-registry
curl -fsS http://localhost:3000/health
```

Point your proxy at `localhost:3000` and confirm
`https://registry.example.com/health` answers.

### 2. Configure storage

From your workstation:

```bash
export PANTRY_REGISTRY_HOST=registry.example.com
export PANTRY_REGISTRY_SSH_KEY=~/.ssh/your-key.pem   # omit to use your agent

STORAGE_PROVIDER=hetzner \
S3_BUCKET=my-registry \
S3_REGION=fsn1 \
S3_ACCESS_KEY_ID=… \
S3_SECRET_ACCESS_KEY=… \
  ./scripts/configure-registry-storage.sh
```

`STORAGE_PROVIDER` accepts `hetzner`, `backblaze` and `aws`; the endpoint is
derived from the provider and region unless you set `S3_ENDPOINT` yourself (for
MinIO or any other S3-compatible service, set it explicitly). On a non-AWS
provider the registry keeps its metadata, auth and analytics as JSON objects in
the bucket, so nothing needs DynamoDB — see [object storage](object-storage.md).

The script writes to the environment file, restarts the service and waits for
`/health`. It is idempotent — re-run it to change providers.

### 3. Set a registry token

```bash
PANTRY_REGISTRY_HOST=registry.example.com ./scripts/rotate-registry-token.sh
```

That prints the token, writes it to the box, restarts the service and verifies
the registry accepts it before reporting success. To also push it to the
repositories that publish from CI:

```bash
./scripts/rotate-registry-token.sh --repos "you/app,you/lib"
```

## Deploying updates

`.github/workflows/deploy-registry.yml` SSHes into the box, fast-forwards the
checkout and restarts the service. To use it on a fork, set these repository
variables and one secret:

| Setting | Kind | Value |
|---------|------|-------|
| `REGISTRY_HOST` | variable | Your registry hostname |
| `REGISTRY_PATH` | variable | Checkout path (default `/opt/pantry-registry/repo`) |
| `REGISTRY_SERVICE` | variable | systemd unit (default `pantry-registry`) |
| `REGISTRY_SSH_KEY` | secret | Private key for the SSH user on the box |

Or deploy however you already deploy — the workflow is a convenience, not a
requirement. The registry is a Bun process reading an environment file.

## Configuration reference

Everything below lives in the registry's environment file.

| Variable | Default | Meaning |
|----------|---------|---------|
| `REGISTRY_VISIBILITY` | `public` | `private` closes every read behind a credential |
| `REGISTRY_PUBLIC_PATHS` | — | Comma-separated path prefixes that stay public on a private registry |
| `REGISTRY_ALLOW_SIGNUP` | follows visibility | Self-serve account creation |
| `REGISTRY_SIGNUP_DOMAINS` | — | Comma-separated email domains allowed to sign up |
| `REGISTRY_PLUGINS` | — | Comma-separated plugin module specifiers |
| `PANTRY_REGISTRY_TOKEN` | — | Shared publish/admin token |
| `PORT` | `3000` | Port the Bun process listens on |
| `BASE_URL` | `http://localhost:$PORT` | Public URL, used in generated links |
| `STORAGE_PROVIDER` | `aws` | `aws`, `hetzner`, `backblaze`, or any S3-compatible endpoint |
| `S3_BUCKET` / `S3_REGION` / `S3_ENDPOINT` | — | Object storage location |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | — | Object storage credentials |
| `METADATA_BACKEND` | derived | `object` (default off AWS), `dynamodb`, or `file` |

On the client side: `PANTRY_REGISTRY_URL` names the registry to talk to, and
`pantry token set --registry <url>` stores the credential for it.

## Verifying end to end

A green `/health` only proves the process is up. Confirm a real round trip, and
— on a private registry — that anonymous access is actually refused:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://registry.example.com/packages/any   # 401
pantry publish --registry https://registry.example.com                               # from a test package
curl -fsS -H "Authorization: Bearer $PANTRY_REGISTRY_TOKEN" \
  https://registry.example.com/api/packages/<name>
```

Restoring metadata without the matching tarballs produces versions that resolve
but cannot be downloaded, so back up the bucket and the metadata snapshot
together — see [the registry contract](registry.md) for the storage model.
