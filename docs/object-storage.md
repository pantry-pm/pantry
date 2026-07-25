# Object Storage (Hetzner / Backblaze / S3)

The registry's object storage — package tarballs, pre-built binaries, and the
package metadata index — runs on any **S3-compatible** provider. **Hetzner Object
Storage** is the recommended low-cost target; Backblaze B2 and AWS S3 work
identically (only endpoint, addressing and credentials differ).

The registry **server still runs on EC2**; only storage moves. Metadata moves
from AWS DynamoDB to a JSON object in the bucket (`metadata/registry-index.json`,
`ObjectMetadataStorage`), so the registry no longer needs DynamoDB.

## Hetzner: what to create

1. In the [Hetzner Cloud Console](https://console.hetzner.cloud/), open your
   project → **Object Storage**.
2. **Create a bucket** (e.g. `pantry-registry`) in a location: `fsn1`
   (Falkenstein), `nbg1` (Nuremberg) or `hel1` (Helsinki). That location is your
   `S3_REGION`; the endpoint is `<location>.your-objectstorage.com`
   (e.g. `fsn1.your-objectstorage.com`).
3. Generate **S3 credentials** for the bucket (access key + secret key). Keep the
   bucket **private** — the registry server proxies downloads
   (`registry.pantry.dev/binaries/...`), so public access isn't required.

That gives you four values: bucket name, region, access key, secret key.

## Values to set

### GitHub repo settings (binary build/sync workflows)

`build.yml` and `sync-binaries.yml` read these. Set on `pantry-pm/pantry`:

| Kind | Name | Value (Hetzner example) |
|------|------|--------------------------|
| Variable | `STORAGE_PROVIDER` | `hetzner` |
| Variable | `S3_BUCKET` | `pantry-registry` |
| Variable | `S3_REGION` | `fsn1` |
| Variable | `S3_ENDPOINT` | *(optional)* `fsn1.your-objectstorage.com` (auto-derived if unset) |
| Secret | `S3_ACCESS_KEY_ID` | your Hetzner access key |
| Secret | `S3_SECRET_ACCESS_KEY` | your Hetzner secret key |

```bash
gh variable set STORAGE_PROVIDER --repo pantry-pm/pantry --body hetzner
gh variable set S3_BUCKET        --repo pantry-pm/pantry --body pantry-registry
gh variable set S3_REGION        --repo pantry-pm/pantry --body fsn1
gh secret   set S3_ACCESS_KEY_ID     --repo pantry-pm/pantry --body '<access-key>'
gh secret   set S3_SECRET_ACCESS_KEY --repo pantry-pm/pantry --body '<secret-key>'
```

Leaving `STORAGE_PROVIDER` unset (or `aws`) keeps everything on S3 — fully reversible.

### Registry server

Point a running registry at the provider. The script writes the storage
configuration into the service's environment file, restarts it, and waits for
`/health`:

```bash
PANTRY_REGISTRY_HOST=registry.example.com \
STORAGE_PROVIDER=hetzner \
S3_BUCKET=my-registry \
S3_REGION=fsn1 \
S3_ACCESS_KEY_ID='<access-key>' \
S3_SECRET_ACCESS_KEY='<secret-key>' \
pantry registry storage
```

Set `PANTRY_REGISTRY_SSH_KEY` if the host needs a specific identity file, and
`PANTRY_SSM_MIRROR=1` to also mirror the values into AWS SSM. Running your own
registry from a fork is covered in [self-hosting](self-hosting.md).

### Local development / `.env`

```bash
STORAGE_PROVIDER=hetzner
S3_BUCKET=pantry-registry
S3_REGION=fsn1
S3_ACCESS_KEY_ID=<access-key>
S3_SECRET_ACCESS_KEY=<secret-key>
# METADATA_BACKEND=object is the default for non-AWS providers.
```

## Environment variable reference

Resolved by `packages/registry/src/storage/provider.ts` and ts-cloud's
`createObjectStorageClient`:

| Var | Purpose |
|-----|---------|
| `STORAGE_PROVIDER` | `aws` \| `hetzner` \| `backblaze` (default `aws`) |
| `S3_BUCKET` | bucket name |
| `S3_REGION` | region/location slug (Hetzner: `fsn1`; Backblaze: `us-west-004`) |
| `S3_ENDPOINT` | endpoint host override; auto-derived per provider+region if unset |
| `S3_FORCE_PATH_STYLE` | `true` to force path-style (default virtual-hosted) |
| `METADATA_BACKEND` | `object` \| `dynamodb` \| `file` (default: `object` for non-AWS) |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | credentials (works for any provider) |
| `HETZNER_S3_ACCESS_KEY` / `HETZNER_S3_SECRET_KEY` | Hetzner-specific (checked first if set) |
| `B2_APPLICATION_KEY_ID` / `B2_APPLICATION_KEY` | Backblaze-specific (checked first if set) |

## Repopulating the bucket

Once the variables/secrets are set, repopulate from CI:

```bash
gh workflow run sync-binaries.yml --repo pantry-pm/pantry   # re-sync pre-built binaries
gh workflow run build.yml         --repo pantry-pm/pantry   # rebuild source packages
```

Watch with `gh run watch <id>`. After the bucket is populated and the server is
pointed at it (verify `curl -fsS https://registry.pantry.dev/health` plus a real
`pantry install`), the old S3 bucket / DynamoDB table can be retired.

## Backblaze B2 (alternative)

Same flow with `STORAGE_PROVIDER=backblaze`, `S3_REGION` like `us-west-004` (from
the bucket's `s3.<region>.backblazeb2.com` endpoint), and an Application Key's
keyID/applicationKey as `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` (the master key
cannot be used with the S3 API).
