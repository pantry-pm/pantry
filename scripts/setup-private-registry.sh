#!/usr/bin/env bash
set -euo pipefail

# Stand up a private Pantry registry on a fresh box, in one command.
#
# Everything the public registry runs on is in this repo, so a private registry
# is the same process with `REGISTRY_VISIBILITY=private`: nothing — metadata,
# tarballs, binaries, search, the web UI — is served without a credential.
#
# This script SSHes into the box and:
#   1. installs Bun (skipped if already present)
#   2. clones (or fast-forwards) the repo checkout
#   3. writes the EnvironmentFile: port, base URL, private visibility, storage
#   4. installs and starts the systemd unit
#   5. generates a registry token and verifies the live server accepts it
#
# It is idempotent — re-run it after changing storage or upgrading the box. An
# existing token is kept unless you pass --rotate-token.
#
# Usage:
#   PANTRY_REGISTRY_HOST=registry.example.com \
#   PANTRY_REGISTRY_REPO=https://github.com/you/your-fork \
#   S3_BUCKET=my-registry \
#   S3_ACCESS_KEY_ID=... \
#   S3_SECRET_ACCESS_KEY=... \
#   STORAGE_PROVIDER=hetzner \
#   S3_REGION=fsn1 \
#     ./scripts/setup-private-registry.sh
#
# Options:
#   --public            Serve reads without authentication (default: private)
#   --rotate-token      Replace the registry token even if one is already set
#   --skip-storage      Leave storage configuration alone (re-runs, or local disk)
#
# Environment:
#   PANTRY_REGISTRY_HOST     Required. Hostname of the box.
#   PANTRY_REGISTRY_SSH_USER SSH user (default: root)
#   PANTRY_REGISTRY_SSH_KEY  Identity file (default: your agent)
#   PANTRY_REGISTRY_REPO     Git URL to deploy (default: this repo's origin)
#   PANTRY_REGISTRY_REF      Branch/tag to check out (default: main)
#   PANTRY_REGISTRY_PATH     Checkout path (default: /opt/pantry-registry/repo)
#   PANTRY_REGISTRY_PORT     Port the Bun process listens on (default: 3000)
#   PANTRY_REGISTRY_URL      Public URL (default: https://$PANTRY_REGISTRY_HOST)
#
# TLS is not configured here: put Caddy, nginx or rpx in front of the port. The
# final output prints a Caddyfile that does it in two lines.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/registry-remote.sh
source "$SCRIPT_DIR/lib/registry-remote.sh"

VISIBILITY=private
ROTATE_TOKEN=0
SKIP_STORAGE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --public) VISIBILITY=public ;;
    --private) VISIBILITY=private ;;
    --rotate-token) ROTATE_TOKEN=1 ;;
    --skip-storage) SKIP_STORAGE=1 ;;
    -h|--help) sed -n '3,48p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
  shift
done

registry_require_config

REPO="${PANTRY_REGISTRY_REPO:-$(git -C "$SCRIPT_DIR/.." remote get-url origin 2>/dev/null || true)}"
REF="${PANTRY_REGISTRY_REF:-main}"
REPO_PATH="${PANTRY_REGISTRY_PATH:-/opt/pantry-registry/repo}"
PORT="${PANTRY_REGISTRY_PORT:-3000}"
ENV_FILE="$PANTRY_REGISTRY_ENV_FILE"
SERVICE="$PANTRY_REGISTRY_SERVICE"

if [[ -z "$REPO" ]]; then
  echo "Error: set PANTRY_REGISTRY_REPO to the git URL to deploy." >&2
  exit 1
fi

echo "==> Target"
echo "    Host:       $PANTRY_REGISTRY_SSH_USER@$PANTRY_REGISTRY_HOST"
echo "    Repo:       $REPO ($REF)"
echo "    Path:       $REPO_PATH"
echo "    URL:        $PANTRY_REGISTRY_URL"
echo "    Visibility: $VISIBILITY"

# ---------------------------------------------------------------------------
# 1-4. Provision the box
#
# One remote script rather than a series of round trips: a half-applied setup
# (unit installed, env file missing) is harder to reason about than a failure
# with nothing changed.
# ---------------------------------------------------------------------------
echo "==> Provisioning..."
registry_ssh bash -s -- \
  "$REPO" "$REF" "$REPO_PATH" "$ENV_FILE" "$SERVICE" "$PORT" "$PANTRY_REGISTRY_URL" "$VISIBILITY" <<'REMOTE'
set -euo pipefail

repo="$1"; ref="$2"; repo_path="$3"; env_file="$4"; service="$5"; port="$6"; base_url="$7"; visibility="$8"

command -v git >/dev/null 2>&1 || { echo "Error: git is not installed on the box." >&2; exit 1; }

# Bun
if ! command -v bun >/dev/null 2>&1 && [ ! -x /root/.bun/bin/bun ]; then
  echo "    Installing Bun..."
  curl -fsSL https://bun.sh/install | bash >/dev/null
fi
bun_bin="$(command -v bun || echo /root/.bun/bin/bun)"
echo "    Bun: $($bun_bin --version)"

# Checkout
if [ -d "$repo_path/.git" ]; then
  echo "    Updating checkout..."
  git -C "$repo_path" fetch --quiet origin "$ref"
  git -C "$repo_path" checkout --quiet "$ref"
  git -C "$repo_path" reset --hard --quiet "origin/$ref"
else
  echo "    Cloning $repo..."
  mkdir -p "$(dirname "$repo_path")"
  git clone --quiet --branch "$ref" "$repo" "$repo_path"
fi

echo "    Installing dependencies..."
(cd "$repo_path" && "$bun_bin" install --frozen-lockfile >/dev/null 2>&1 || "$bun_bin" install >/dev/null)

# Environment file. Created empty-but-present so registry_set_env can edit it;
# existing values (a token, storage credentials) are left alone.
mkdir -p "$(dirname "$env_file")"
[ -f "$env_file" ] || install -m 600 /dev/null "$env_file"
chmod 600 "$env_file"

set_env() {
  key="$1"; value="$2"
  if grep -q "^${key}=" "$env_file"; then
    awk -v k="$key" -v v="$value" '$0 ~ "^"k"=" {print k"="v; next} {print}' "$env_file" > "$env_file.tmp"
    mv "$env_file.tmp" "$env_file"
  else
    printf '%s=%s\n' "$key" "$value" >> "$env_file"
  fi
}

set_env PORT "$port"
set_env BASE_URL "$base_url"
set_env REGISTRY_VISIBILITY "$visibility"
chmod 600 "$env_file"

# systemd unit. Environment comes from the file, never from `Environment=`
# lines: systemd applies directives in order, so a unit line above an
# EnvironmentFile= is silently overridden by it.
cat > "/etc/systemd/system/${service}.service" <<UNIT
[Unit]
Description=Pantry Registry
After=network.target

[Service]
Type=simple
WorkingDirectory=${repo_path}/packages/registry
EnvironmentFile=${env_file}
ExecStart=${bun_bin} run src/server.ts
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --quiet "$service"
systemctl restart "$service"
sleep 2
systemctl is-active "$service"

for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS "http://localhost:${port}/health" >/dev/null 2>&1; then
    echo "    Local health check passed."
    exit 0
  fi
  sleep 2
done

echo "Error: the service did not answer /health on localhost:${port}." >&2
echo "Logs: journalctl -u ${service} -n 50 --no-pager" >&2
exit 1
REMOTE

echo "    Provisioned."

# ---------------------------------------------------------------------------
# Storage
# ---------------------------------------------------------------------------
if [[ "$SKIP_STORAGE" == "1" ]]; then
  echo "==> Storage: skipped (--skip-storage)."
elif [[ -n "${S3_BUCKET:-}" ]]; then
  echo "==> Configuring object storage (${STORAGE_PROVIDER:-aws} / ${S3_BUCKET})..."
  "$SCRIPT_DIR/configure-registry-storage.sh"
else
  echo "==> Storage: no S3_BUCKET given, leaving storage configuration alone."
  echo "    Set S3_BUCKET / S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY and re-run,"
  echo "    or run ./scripts/configure-registry-storage.sh later."
fi

# ---------------------------------------------------------------------------
# Token
# ---------------------------------------------------------------------------
existing_token=$(registry_ssh "grep -m1 '^PANTRY_REGISTRY_TOKEN=' '$ENV_FILE' 2>/dev/null | cut -d= -f2-" || true)

if [[ -n "$existing_token" && "$ROTATE_TOKEN" != "1" ]]; then
  echo "==> Token: already set, keeping it (pass --rotate-token to replace)."
  TOKEN="$existing_token"
else
  echo "==> Generating registry token..."
  TOKEN=$(bun -e "console.log('ptry_' + require('node:crypto').randomBytes(32).toString('hex'))")
  registry_set_env "PANTRY_REGISTRY_TOKEN=$TOKEN"
  registry_restart >/dev/null
  echo "    Written and service restarted."
fi

# ---------------------------------------------------------------------------
# Verify from the outside
# ---------------------------------------------------------------------------
echo "==> Verifying ${PANTRY_REGISTRY_URL}..."
if ! registry_wait_healthy 10; then
  echo "    The process is up locally but the public URL didn't answer." >&2
  echo "    That's usually TLS/proxy: point your proxy at localhost:${PORT}." >&2
fi

info=$(curl -fsS --max-time 15 "${PANTRY_REGISTRY_URL}/api/registry-info" 2>/dev/null || echo '')
if [[ -n "$info" ]]; then
  echo "    Registry reports: $info"
fi

if [[ "$VISIBILITY" == "private" ]]; then
  anon=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${PANTRY_REGISTRY_URL}/packages/any-package" || echo 000)
  authed=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 \
    -H "Authorization: Bearer $TOKEN" "${PANTRY_REGISTRY_URL}/packages/any-package" || echo 000)
  echo "    Anonymous read: HTTP $anon (expected 401)"
  echo "    Authenticated read: HTTP $authed (expected anything but 401)"
  if [[ "$anon" != "401" ]]; then
    echo "    WARNING: anonymous reads are NOT being refused. Check REGISTRY_VISIBILITY in $ENV_FILE." >&2
  fi
fi

cat <<DONE

Done. Your registry is live at ${PANTRY_REGISTRY_URL}.

Token (store it somewhere safe — it is the admin credential):

  ${TOKEN}

Publish to it:

  echo '${TOKEN}' | pantry token set --registry ${PANTRY_REGISTRY_URL}
  pantry publish --registry ${PANTRY_REGISTRY_URL}

Install from it (any machine, with a token stored as above):

  export PANTRY_REGISTRY_URL=${PANTRY_REGISTRY_URL}
  pantry install

Add a teammate (private registries have signups closed by default):

  curl -X POST ${PANTRY_REGISTRY_URL}/admin/users \\
    -H "Authorization: Bearer ${TOKEN}" -H 'Content-Type: application/json' \\
    -d '{"email":"dev@yourco.com","name":"Dev","password":"..."}'

  curl -X POST ${PANTRY_REGISTRY_URL}/admin/tokens \\
    -H "Authorization: Bearer ${TOKEN}" -H 'Content-Type: application/json' \\
    -d '{"email":"dev@yourco.com","name":"laptop","permissions":["read"]}'

Terminate TLS in front of the process, e.g. a two-line Caddyfile:

  ${PANTRY_REGISTRY_HOST} {
    reverse_proxy localhost:${PORT}
  }

More: docs/self-hosting.md
DONE
