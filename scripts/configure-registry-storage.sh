#!/usr/bin/env bash
set -euo pipefail

# Point the running Pantry registry at an S3-compatible object storage provider
# — Hetzner Object Storage or Backblaze B2 — for tarballs, binaries and the
# object metadata snapshot. The registry runs on the Hetzner box
# (registry.pantry.dev, login as root); this only changes where it stores data.
#
# This writes the storage configuration into the server's systemd unit and
# restarts it, and optionally mirrors the values into AWS SSM (/pantry/storage-*)
# so they can be reapplied on a fresh box (SKIP_SSM=1 to skip the AWS mirror).
#
# Prerequisites:
#   - A bucket on the provider + S3 credentials (access key id + secret).
#       Hetzner:   Cloud Console → Object Storage → bucket → credentials.
#       Backblaze: create a bucket + an Application Key (keyID + applicationKey).
#   - SSH key at ~/.ssh/stacks-production.pem (root@registry.pantry.dev).
#   - AWS CLI configured (us-east-1) — only for the optional SSM mirror.
#
# Usage (env vars):
#   STORAGE_PROVIDER=hetzner \
#   S3_BUCKET=pantry-registry \
#   S3_REGION=fsn1 \
#   S3_ACCESS_KEY_ID=<access-key> \
#   S3_SECRET_ACCESS_KEY=<secret-key> \
#   ./scripts/configure-registry-storage.sh
#
# Optional:
#   S3_ENDPOINT=fsn1.your-objectstorage.com   (default: derived from provider+region)
#   METADATA_BACKEND=object                    (default: object)
#   SKIP_SSM=1                                  (don't write to AWS SSM)

# registry.pantry.dev always resolves to the current Hetzner box, which (like
# every Hetzner Cloud image) logs in as root.
REGISTRY_HOST="${REGISTRY_HOST:-registry.pantry.dev}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/stacks-production.pem}"
SSH_USER="${SSH_USER:-root}"
SERVICE_FILE="/etc/systemd/system/pantry-registry.service"
AWS_SSM_REGION="us-east-1"

: "${STORAGE_PROVIDER:?Set STORAGE_PROVIDER (hetzner | backblaze)}"
: "${S3_BUCKET:?Set S3_BUCKET to your bucket name}"
: "${S3_REGION:?Set S3_REGION (Hetzner: fsn1|nbg1|hel1, Backblaze: e.g. us-west-004)}"
: "${S3_ACCESS_KEY_ID:?Set S3_ACCESS_KEY_ID}"
: "${S3_SECRET_ACCESS_KEY:?Set S3_SECRET_ACCESS_KEY}"

# Derive the endpoint from the provider + region if not given explicitly.
if [[ -z "${S3_ENDPOINT:-}" ]]; then
  case "$STORAGE_PROVIDER" in
    hetzner)   S3_ENDPOINT="${S3_REGION}.your-objectstorage.com" ;;
    backblaze) S3_ENDPOINT="s3.${S3_REGION}.backblazeb2.com" ;;
    *) echo "Unknown STORAGE_PROVIDER '$STORAGE_PROVIDER'; set S3_ENDPOINT explicitly." >&2; exit 1 ;;
  esac
fi
METADATA_BACKEND="${METADATA_BACKEND:-object}"

echo "==> Registry object-storage configuration"
echo "    Provider: $STORAGE_PROVIDER"
echo "    Bucket:   $S3_BUCKET"
echo "    Region:   $S3_REGION"
echo "    Endpoint: $S3_ENDPOINT"
echo "    Metadata: $METADATA_BACKEND"
echo "    Key ID:   ${S3_ACCESS_KEY_ID:0:6}…"

if [[ "${SKIP_SSM:-0}" != "1" ]]; then
  echo "==> Mirroring config to AWS SSM (/pantry/storage-*)…"
  aws ssm put-parameter --name /pantry/storage-provider   --type String       --value "$STORAGE_PROVIDER"     --region "$AWS_SSM_REGION" --overwrite >/dev/null
  aws ssm put-parameter --name /pantry/storage-bucket     --type String       --value "$S3_BUCKET"            --region "$AWS_SSM_REGION" --overwrite >/dev/null
  aws ssm put-parameter --name /pantry/storage-region     --type String       --value "$S3_REGION"            --region "$AWS_SSM_REGION" --overwrite >/dev/null
  aws ssm put-parameter --name /pantry/storage-endpoint   --type String       --value "$S3_ENDPOINT"          --region "$AWS_SSM_REGION" --overwrite >/dev/null
  aws ssm put-parameter --name /pantry/storage-access-key-id --type SecureString --value "$S3_ACCESS_KEY_ID"  --region "$AWS_SSM_REGION" --overwrite >/dev/null
  aws ssm put-parameter --name /pantry/storage-secret-key --type SecureString  --value "$S3_SECRET_ACCESS_KEY" --region "$AWS_SSM_REGION" --overwrite >/dev/null
  echo "    Stored."
fi

echo "==> Updating registry server ($REGISTRY_HOST)…"
# shellcheck disable=SC2087
# We log in as root on the Hetzner box, so no sudo is needed (minimal Hetzner
# images don't ship sudo at all).
ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no "$SSH_USER@$REGISTRY_HOST" "
  set -e
  # Drop any prior storage env lines so re-running is idempotent.
  sed -i '/^Environment=STORAGE_PROVIDER/d;/^Environment=S3_BUCKET/d;/^Environment=S3_REGION/d;/^Environment=S3_ENDPOINT/d;/^Environment=METADATA_BACKEND/d;/^Environment=S3_ACCESS_KEY_ID/d;/^Environment=S3_SECRET_ACCESS_KEY/d' $SERVICE_FILE
  # Append the storage configuration to the [Service] section.
  sed -i '/^\[Service\]/a Environment=STORAGE_PROVIDER=$STORAGE_PROVIDER\nEnvironment=S3_BUCKET=$S3_BUCKET\nEnvironment=S3_REGION=$S3_REGION\nEnvironment=S3_ENDPOINT=$S3_ENDPOINT\nEnvironment=METADATA_BACKEND=$METADATA_BACKEND\nEnvironment=S3_ACCESS_KEY_ID=$S3_ACCESS_KEY_ID\nEnvironment=S3_SECRET_ACCESS_KEY=$S3_SECRET_ACCESS_KEY' $SERVICE_FILE
  systemctl daemon-reload
  systemctl restart pantry-registry
  sleep 2
  systemctl is-active pantry-registry
" 2>/dev/null
echo "    Registry restarted."

echo ""
echo "Done. The registry now uses $STORAGE_PROVIDER ($S3_BUCKET @ $S3_ENDPOINT)."
echo "Verify: curl -fsS https://registry.pantry.dev/health"
