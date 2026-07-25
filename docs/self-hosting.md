# Running your own registry

Everything the public registry runs on is in this repo. Fork it, point the
scripts at your own box, and you have a private registry for your packages —
no part of the deployment depends on the maintainers' infrastructure.

This walks through a single-box deployment. For the API surface and storage
guarantees, see [the registry contract](registry.md).

## What you need

- **A server** with a public hostname. Any Linux box will do; the registry is a
  single Bun process.
- **An S3-compatible bucket** for tarballs and metadata — Hetzner Object
  Storage, Backblaze B2, AWS S3, MinIO. Keep it private.
- **A TLS-terminating proxy** in front of the process (Caddy, nginx, rpx).

Nothing here requires an AWS account. The AWS SSM support in the scripts is an
optional mirror, off by default.

## 1. Provision the box

Install Bun and check out your fork:

```bash
curl -fsSL https://bun.sh/install | bash

install -d /opt/pantry-registry
git clone https://github.com/<you>/<your-fork> /opt/pantry-registry/repo
cd /opt/pantry-registry/repo && bun install
```

Create the environment file the service reads. Keep it `0600` — it holds your
storage credentials and publish token:

```bash
install -m 600 /dev/null /opt/pantry-registry/registry.env
cat > /opt/pantry-registry/registry.env <<'EOF'
PORT=3000
BASE_URL=https://registry.example.com
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

Point your proxy at `localhost:3000` and confirm `https://registry.example.com/health`
answers.

## 2. Configure storage

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
MinIO or any other S3-compatible service, set it explicitly).

The script writes to the environment file, restarts the service and waits for
`/health`. It is idempotent — re-run it to change providers.

## 3. Set a publish token

The registry authorises publishes against a shared token in
`PANTRY_REGISTRY_TOKEN`. Generate one and install it:

```bash
PANTRY_REGISTRY_HOST=registry.example.com ./scripts/rotate-registry-token.sh
```

That prints the token, writes it to the box, restarts the service and verifies
the registry accepts it before reporting success. To also push it to the
repositories that publish from CI:

```bash
./scripts/rotate-registry-token.sh --repos "you/app,you/lib"
```

Rotating later is the same command. It updates the server first and only touches
GitHub secrets once the live registry accepts the new value, so a failed server
update can't leave CI holding a token the server rejects.

## 4. Point clients at it

Store the token once, then publish:

```bash
pantry token set --registry https://registry.example.com   # reads from stdin
pantry publish --registry https://registry.example.com
```

The credential is scoped to that registry, so publishing to a different one
still uses its own token. For CI:

```bash
pantry token sync --repo you/app --registry https://registry.example.com
```

To resolve installs from your registry, set it in `pantry.toml`:

```toml
[install]
registry = "https://registry.example.com/"
```

## 5. Deploying updates

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

## Verifying end to end

A green `/health` only proves the process is up. Confirm a real round trip:

```bash
pantry publish --registry https://registry.example.com   # from a test package
curl -fsS https://registry.example.com/api/packages/<name>
```

Restoring metadata without the matching tarballs produces versions that resolve
but cannot be downloaded, so back up the bucket and the metadata snapshot
together — see [the registry contract](registry.md) for the storage model.
