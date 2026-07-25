#!/usr/bin/env bash
set -euo pipefail

# Rotate a Pantry registry's publish token.
#
# 1. Generates a new ptry_ token
# 2. Optionally mirrors it to AWS SSM
# 3. Writes it into the registry host's EnvironmentFile (backing up the old one)
# 4. Restarts the registry service
# 5. Verifies the live registry accepts the new token
# 6. Updates the PANTRY_TOKEN GitHub secret on the repos that publish
#
# Step 5 gates step 6 on purpose: if the server update didn't land, the GitHub
# secrets are left alone, so CI keeps working on the token the server still
# accepts. The alternative — rotating secrets first — breaks every publishing
# repo at once with nothing to point at.
#
# Works against any registry you run. See docs/self-hosting.md.
#
# Prerequisites:
#   - SSH access to the registry host
#   - gh CLI authenticated (only if updating GitHub secrets)
#   - AWS CLI (only with PANTRY_SSM_MIRROR=1)
#
# Usage:
#   PANTRY_REGISTRY_HOST=registry.example.com \
#   PANTRY_TOKEN_REPOS="owner/one,owner/two" \
#     ./scripts/rotate-registry-token.sh
#
#   ./scripts/rotate-registry-token.sh --repos "owner/one,owner/two"
#
# Optional:
#   PANTRY_SSM_MIRROR=1       (mirror the token to AWS SSM)
#   PANTRY_SSM_PARAM=/pantry/registry-token
#   AWS_REGION=us-east-1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/registry-remote.sh
source "$SCRIPT_DIR/lib/registry-remote.sh"

registry_require_config

# Which repositories publish to this registry. No default: the maintainers' repo
# list is not a sensible thing for a fork to inherit — it lives in the operator's
# own environment or is passed explicitly.
REPOS="${PANTRY_TOKEN_REPOS:-}"
if [[ "${1:-}" == "--repos" ]]; then
  REPOS="${2:-}"
elif [[ -n "${1:-}" ]]; then
  REPOS="$1"
fi

echo "==> Generating new token..."
TOKEN=$(bun -e "console.log('ptry_' + require('node:crypto').randomBytes(32).toString('hex'))")
echo "    Token: ${TOKEN:0:20}..."

if [[ "${PANTRY_SSM_MIRROR:-0}" == "1" ]]; then
  ssm_param="${PANTRY_SSM_PARAM:-/pantry/registry-token}"
  aws_region="${AWS_REGION:-us-east-1}"
  echo "==> Storing in AWS SSM ($ssm_param)..."
  aws ssm put-parameter \
    --name "$ssm_param" \
    --type "SecureString" \
    --value "$TOKEN" \
    --description "Pantry registry publish token (rotated $(date -u +%Y-%m-%dT%H:%M:%SZ))" \
    --region "$aws_region" \
    --overwrite > /dev/null
  echo "    Stored."
fi

echo "==> Updating registry host ($PANTRY_REGISTRY_HOST)..."
registry_set_env "PANTRY_REGISTRY_TOKEN=$TOKEN"
echo "    Written to $PANTRY_REGISTRY_ENV_FILE."

echo "==> Restarting ${PANTRY_REGISTRY_SERVICE}..."
registry_restart
echo "    Restarted."

echo "==> Verifying the server accepts the new token..."
# A publish with no body: 401 means the server is still on the old token;
# anything else means authentication passed and it went on to validate the
# request itself.
for attempt in 1 2 3 4 5; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "${PANTRY_REGISTRY_URL}/zig/publish" \
    -H "Authorization: Bearer $TOKEN" || echo 000)
  if [[ "$code" != "401" && "$code" != "000" && "$code" != "502" && "$code" != "503" ]]; then
    echo "    Accepted (HTTP $code)."
    break
  fi
  if [[ "$attempt" == "5" ]]; then
    echo "    ERROR: registry still rejects the new token (HTTP $code)." >&2
    echo "    The server and any SSM mirror are now out of sync with CI." >&2
    echo "    GitHub secrets were NOT updated — publishing still works on the old token." >&2
    exit 1
  fi
  sleep 3
done

if [[ -z "$REPOS" ]]; then
  echo ""
  echo "Done. No repositories given, so no GitHub secrets were updated."
  echo "Pass --repos \"owner/name,...\" or set PANTRY_TOKEN_REPOS to update CI."
  echo "A single repo can also be updated with:"
  echo "  pantry token set && pantry token sync --repo owner/name"
  exit 0
fi

echo "==> Updating GitHub secrets..."
IFS=',' read -ra REPO_LIST <<< "$REPOS"
for repo in "${REPO_LIST[@]}"; do
  repo=$(echo "$repo" | xargs) # trim whitespace
  [[ -z "$repo" ]] && continue
  gh secret set PANTRY_TOKEN --repo "$repo" --body "$TOKEN"
  echo "    Updated: $repo"
done

echo ""
echo "Done. Token rotated successfully."
echo "Registry: $PANTRY_REGISTRY_HOST"
echo "Repos:    $REPOS"
