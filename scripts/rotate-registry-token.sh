#!/usr/bin/env bash
set -euo pipefail

# Rotate the Pantry Registry token.
#
# This script:
# 1. Generates a new ptry_ token
# 2. Stores it in AWS SSM (/pantry/registry-token)
# 3. Updates the registry server's systemd config
# 4. Restarts the registry service
# 5. Updates GitHub secrets on specified repos
#
# Prerequisites:
#   - AWS CLI configured (us-east-1)
#   - SSH key at ~/.ssh/stacks-production.pem
#   - gh CLI authenticated
#
# Usage:
#   ./scripts/rotate-registry-token.sh
#   ./scripts/rotate-registry-token.sh --repos "pickier/pickier,pantry-pm/pantry"

# registry.pantry.dev resolves to the current Hetzner box; log in as root.
REGISTRY_HOST="registry.pantry.dev"
SSH_KEY="$HOME/.ssh/stacks-production.pem"
SSH_USER="root"
SSM_PARAM="/pantry/registry-token"
AWS_REGION="us-east-1"
SERVICE_FILE="/etc/systemd/system/pantry-registry.service"
# The unit reads its environment from this file (EnvironmentFile=), not from
# Environment= lines in the unit itself. The token has to be written here or the
# server keeps validating against the old value.
ENV_FILE="/opt/pantry-registry/registry.env"

# Default repos to update
DEFAULT_REPOS="pickier/pickier,pantry-pm/pantry,cwcss/crosswind,den-shell/den"

# Parse args
REPOS="${1:---repos}"
if [[ "$REPOS" == "--repos" ]]; then
  REPOS="${2:-$DEFAULT_REPOS}"
fi
if [[ "$REPOS" == "$DEFAULT_REPOS" ]] && [[ "${1:-}" != "--repos" ]] && [[ -n "${1:-}" ]]; then
  REPOS="$1"
fi
[[ "$REPOS" == "--repos" ]] && REPOS="$DEFAULT_REPOS"

echo "==> Generating new token..."
TOKEN=$(bun -e "console.log('ptry_' + require('node:crypto').randomBytes(32).toString('hex'))")
echo "    Token: ${TOKEN:0:20}..."

echo "==> Storing in AWS SSM ($SSM_PARAM)..."
aws ssm put-parameter \
  --name "$SSM_PARAM" \
  --type "SecureString" \
  --value "$TOKEN" \
  --description "Pantry registry admin token for commit publishing (rotated $(date -u +%Y-%m-%dT%H:%M:%SZ))" \
  --region "$AWS_REGION" \
  --overwrite > /dev/null
echo "    Stored."

echo "==> Updating registry server ($REGISTRY_HOST)..."
# We log in as root on the Hetzner box, so no sudo is needed (minimal Hetzner
# images don't ship sudo at all).
#
# The token goes into the unit's EnvironmentFile. An earlier version of this
# script edited Environment= lines in the unit file instead — the unit has none,
# so the edit silently matched nothing and the server kept the old token while
# SSM and every GitHub secret moved to the new one. That breaks publishing for
# every repo at once, so the write is verified below rather than assumed.
ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no "$SSH_USER@$REGISTRY_HOST" bash -s <<SSH_EOF
set -euo pipefail

if [ ! -f "$ENV_FILE" ]; then
  echo "    ERROR: $ENV_FILE not found — is the registry deployed here?" >&2
  exit 1
fi

# Keep a timestamped backup so a bad rotation can be undone by hand.
cp "$ENV_FILE" "$ENV_FILE.bak.\$(date -u +%Y%m%d%H%M%S)"

# Replace the existing assignment, or append if the key isn't there yet.
if grep -q '^PANTRY_REGISTRY_TOKEN=' "$ENV_FILE"; then
  sed -i "s|^PANTRY_REGISTRY_TOKEN=.*|PANTRY_REGISTRY_TOKEN=$TOKEN|" "$ENV_FILE"
else
  printf 'PANTRY_REGISTRY_TOKEN=%s\n' "$TOKEN" >> "$ENV_FILE"
fi

# Fail loudly rather than restarting into a half-applied config.
if ! grep -qx "PANTRY_REGISTRY_TOKEN=$TOKEN" "$ENV_FILE"; then
  echo "    ERROR: token was not written to $ENV_FILE" >&2
  exit 1
fi

chmod 600 "$ENV_FILE"
systemctl daemon-reload
systemctl restart pantry-registry
SSH_EOF
echo "    Registry restarted."

echo "==> Verifying the server accepts the new token..."
# A publish with no body: 401 means the server is still on the old token, and
# anything else means authentication passed and it got as far as validating the
# request itself.
for attempt in 1 2 3 4 5; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "https://$REGISTRY_HOST/zig/publish" \
    -H "Authorization: Bearer $TOKEN" || echo 000)
  if [[ "$code" != "401" && "$code" != "000" && "$code" != "502" && "$code" != "503" ]]; then
    echo "    Accepted (HTTP $code)."
    break
  fi
  if [[ "$attempt" == "5" ]]; then
    echo "    ERROR: registry still rejects the new token (HTTP $code)." >&2
    echo "    SSM and the server are now out of sync — do not update GitHub secrets." >&2
    exit 1
  fi
  sleep 3
done

echo "==> Updating GitHub secrets..."
IFS=',' read -ra REPO_LIST <<< "$REPOS"
for repo in "${REPO_LIST[@]}"; do
  repo=$(echo "$repo" | xargs) # trim whitespace
  gh secret set PANTRY_TOKEN --repo "$repo" --body "$TOKEN"
  echo "    Updated: $repo"
done

echo ""
echo "Done. Token rotated successfully."
echo "SSM:      $SSM_PARAM"
echo "Server:   $REGISTRY_HOST"
echo "Repos:    $REPOS"
