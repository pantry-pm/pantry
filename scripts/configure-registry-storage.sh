#!/usr/bin/env bash
set -euo pipefail

# Point a running Pantry registry at an S3-compatible object storage provider
# for tarballs, binaries and the object metadata snapshot.
#
# Works against any registry you run — set PANTRY_REGISTRY_HOST to your own box.
# See docs/self-hosting.md to stand one up from a fork.
#
# Prerequisites:
#   - A bucket on the provider + S3 credentials (access key id + secret).
#       Hetzner:   Cloud Console → Object Storage → bucket → credentials.
#       Backblaze: create a bucket + an Application Key (keyID + applicationKey).
#       AWS:       an S3 bucket + IAM access key.
#   - SSH access to the registry host (see scripts/lib/registry-remote.sh).
#
# Usage:
#   PANTRY_REGISTRY_HOST=registry.example.com \
#   STORAGE_PROVIDER=hetzner \
#   S3_BUCKET=my-registry \
#   S3_REGION=fsn1 \
#   S3_ACCESS_KEY_ID=<access-key> \
#   S3_SECRET_ACCESS_KEY=<secret-key> \
#   ./scripts/configure-registry-storage.sh
#
# Optional:
#   S3_ENDPOINT=fsn1.your-objectstorage.com   (default: derived from provider+region)
#   METADATA_BACKEND=object                    (default: object)
#   PANTRY_SSM_MIRROR=1                        (also mirror to AWS SSM)
#   PANTRY_SSM_PREFIX=/pantry                  (SSM parameter prefix)
#   AWS_REGION=us-east-1                       (region for the SSM mirror)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/registry-remote.sh
source "$SCRIPT_DIR/lib/registry-remote.sh"

registry_require_config

: "${STORAGE_PROVIDER:?Set STORAGE_PROVIDER (hetzner | backblaze | aws)}"
: "${S3_BUCKET:?Set S3_BUCKET to your bucket name}"
: "${S3_REGION:?Set S3_REGION (Hetzner: fsn1|nbg1|hel1, Backblaze: e.g. us-west-004, AWS: e.g. us-east-1)}"
: "${S3_ACCESS_KEY_ID:?Set S3_ACCESS_KEY_ID}"
: "${S3_SECRET_ACCESS_KEY:?Set S3_SECRET_ACCESS_KEY}"

# Derive the endpoint from the provider + region if not given explicitly.
if [[ -z "${S3_ENDPOINT:-}" ]]; then
  case "$STORAGE_PROVIDER" in
    hetzner)   S3_ENDPOINT="${S3_REGION}.your-objectstorage.com" ;;
    backblaze) S3_ENDPOINT="s3.${S3_REGION}.backblazeb2.com" ;;
    aws)       S3_ENDPOINT="s3.${S3_REGION}.amazonaws.com" ;;
    *) echo "Unknown STORAGE_PROVIDER '$STORAGE_PROVIDER'; set S3_ENDPOINT explicitly." >&2; exit 1 ;;
  esac
fi
METADATA_BACKEND="${METADATA_BACKEND:-object}"

echo "==> Registry object-storage configuration"
echo "    Host:     $PANTRY_REGISTRY_HOST"
echo "    Provider: $STORAGE_PROVIDER"
echo "    Bucket:   $S3_BUCKET"
echo "    Region:   $S3_REGION"
echo "    Endpoint: $S3_ENDPOINT"
echo "    Metadata: $METADATA_BACKEND"
echo "    Key ID:   ${S3_ACCESS_KEY_ID:0:6}…"

# Opt-in, not opt-out: most deployments have no AWS account at all, and the
# registry doesn't need one — SSM is only a convenience mirror so a fresh box
# can be reconfigured from a known-good copy.
if [[ "${PANTRY_SSM_MIRROR:-0}" == "1" ]]; then
  ssm_prefix="${PANTRY_SSM_PREFIX:-/pantry}"
  aws_region="${AWS_REGION:-us-east-1}"
  echo "==> Mirroring config to AWS SSM (${ssm_prefix}/storage-*)…"
  aws ssm put-parameter --name "${ssm_prefix}/storage-provider"      --type String       --value "$STORAGE_PROVIDER"     --region "$aws_region" --overwrite >/dev/null
  aws ssm put-parameter --name "${ssm_prefix}/storage-bucket"        --type String       --value "$S3_BUCKET"            --region "$aws_region" --overwrite >/dev/null
  aws ssm put-parameter --name "${ssm_prefix}/storage-region"        --type String       --value "$S3_REGION"            --region "$aws_region" --overwrite >/dev/null
  aws ssm put-parameter --name "${ssm_prefix}/storage-endpoint"      --type String       --value "$S3_ENDPOINT"          --region "$aws_region" --overwrite >/dev/null
  aws ssm put-parameter --name "${ssm_prefix}/storage-access-key-id" --type SecureString --value "$S3_ACCESS_KEY_ID"     --region "$aws_region" --overwrite >/dev/null
  aws ssm put-parameter --name "${ssm_prefix}/storage-secret-key"    --type SecureString --value "$S3_SECRET_ACCESS_KEY" --region "$aws_region" --overwrite >/dev/null
  echo "    Stored."
fi

echo "==> Updating registry host ($PANTRY_REGISTRY_HOST)…"
registry_set_env \
  "STORAGE_PROVIDER=$STORAGE_PROVIDER" \
  "S3_BUCKET=$S3_BUCKET" \
  "S3_REGION=$S3_REGION" \
  "S3_ENDPOINT=$S3_ENDPOINT" \
  "METADATA_BACKEND=$METADATA_BACKEND" \
  "S3_ACCESS_KEY_ID=$S3_ACCESS_KEY_ID" \
  "S3_SECRET_ACCESS_KEY=$S3_SECRET_ACCESS_KEY"
echo "    Written to $PANTRY_REGISTRY_ENV_FILE."

echo "==> Restarting ${PANTRY_REGISTRY_SERVICE}…"
registry_restart
registry_wait_healthy || true

echo ""
echo "Done. The registry now uses $STORAGE_PROVIDER ($S3_BUCKET @ $S3_ENDPOINT)."
echo "Verify: curl -fsS ${PANTRY_REGISTRY_URL}/health"
