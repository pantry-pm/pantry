# shellcheck shell=bash
#
# Shared helpers for configuring a running Pantry registry over SSH.
#
# Nothing here is specific to any one deployment: point the variables below at
# your own host and these work against a registry you run yourself. Fork the
# repo, provision a box (see docs/self-hosting.md), and the same scripts apply.
#
# Configuration (environment):
#   PANTRY_REGISTRY_HOST      Required. Hostname of the registry box.
#   PANTRY_REGISTRY_SSH_USER  SSH user (default: root).
#   PANTRY_REGISTRY_SSH_KEY   Identity file. Optional — omit to use your agent.
#   PANTRY_REGISTRY_SERVICE   systemd unit name (default: pantry-registry).
#   PANTRY_REGISTRY_ENV_FILE  Unit's EnvironmentFile (default: /opt/pantry-registry/registry.env).
#   PANTRY_REGISTRY_URL       Public URL for health checks (default: https://$HOST).
#
# The older REGISTRY_HOST / SSH_KEY / SSH_USER names are still accepted.

PANTRY_REGISTRY_HOST="${PANTRY_REGISTRY_HOST:-${REGISTRY_HOST:-}}"
PANTRY_REGISTRY_SSH_USER="${PANTRY_REGISTRY_SSH_USER:-${SSH_USER:-root}}"
PANTRY_REGISTRY_SSH_KEY="${PANTRY_REGISTRY_SSH_KEY:-${SSH_KEY:-}}"
PANTRY_REGISTRY_SERVICE="${PANTRY_REGISTRY_SERVICE:-pantry-registry}"
PANTRY_REGISTRY_ENV_FILE="${PANTRY_REGISTRY_ENV_FILE:-/opt/pantry-registry/registry.env}"

# Deliberately no default host. A default pointing at the maintainers' registry
# would mean a fork that forgets to set this tries to reconfigure someone else's
# server.
registry_require_config() {
  if [[ -z "$PANTRY_REGISTRY_HOST" ]]; then
    cat >&2 <<'MSG'
Error: PANTRY_REGISTRY_HOST is not set.

Point it at your own registry host, e.g.:

  export PANTRY_REGISTRY_HOST=registry.example.com
  export PANTRY_REGISTRY_SSH_KEY=~/.ssh/your-key.pem

See docs/self-hosting.md for provisioning a registry from a fork.
MSG
    return 1
  fi
}

PANTRY_REGISTRY_URL="${PANTRY_REGISTRY_URL:-https://${PANTRY_REGISTRY_HOST}}"

registry_ssh() {
  local -a args=(-o StrictHostKeyChecking=no -o ConnectTimeout=20)
  [[ -n "$PANTRY_REGISTRY_SSH_KEY" ]] && args+=(-i "$PANTRY_REGISTRY_SSH_KEY")
  ssh "${args[@]}" "${PANTRY_REGISTRY_SSH_USER}@${PANTRY_REGISTRY_HOST}" "$@"
}

# Set KEY=VALUE pairs in the unit's EnvironmentFile, then restart the service.
#
# The values go in the EnvironmentFile rather than as `Environment=` lines in
# the unit: systemd applies directives in order, so unit lines inserted above an
# `EnvironmentFile=` are overridden by it. Scripts that wrote the unit appeared
# to succeed — service restarted, no error — while changing nothing the process
# actually read.
#
# Each key is replaced in place or appended, the file is backed up first, and
# every write is read back before the service is restarted.
registry_set_env() {
  registry_require_config || return 1

  local pairs=("$@")
  if [[ ${#pairs[@]} -eq 0 ]]; then
    echo "registry_set_env: no KEY=VALUE pairs given" >&2
    return 1
  fi

  local remote_script
  remote_script=$(
    cat <<'REMOTE'
set -euo pipefail

env_file="$1"; shift

if [ ! -f "$env_file" ]; then
  echo "Error: $env_file not found on the registry host." >&2
  echo "Is the registry deployed here, and is PANTRY_REGISTRY_ENV_FILE correct?" >&2
  exit 1
fi

cp "$env_file" "$env_file.bak.$(date -u +%Y%m%d%H%M%S)"

for pair in "$@"; do
  key="${pair%%=*}"
  value="${pair#*=}"

  if grep -q "^${key}=" "$env_file"; then
    # Rewrite with awk rather than sed: the value can contain slashes and other
    # characters that would need escaping in a sed replacement.
    awk -v k="$key" -v v="$value" \
      'BEGIN{done=0} $0 ~ "^"k"=" {print k"="v; done=1; next} {print} END{if(!done) print k"="v}' \
      "$env_file" > "$env_file.tmp"
    mv "$env_file.tmp" "$env_file"
  else
    printf '%s=%s\n' "$key" "$value" >> "$env_file"
  fi

  if ! grep -qxF "${key}=${value}" "$env_file"; then
    echo "Error: ${key} was not written to $env_file" >&2
    exit 1
  fi
done

chmod 600 "$env_file"
REMOTE
  )

  registry_ssh bash -s -- "$PANTRY_REGISTRY_ENV_FILE" "${pairs[@]}" <<<"$remote_script"
}

registry_restart() {
  registry_require_config || return 1
  registry_ssh "systemctl daemon-reload && systemctl restart '${PANTRY_REGISTRY_SERVICE}' && sleep 2 && systemctl is-active '${PANTRY_REGISTRY_SERVICE}'"
}

# Poll the public health endpoint. A restart returns before the process is
# accepting connections, so a single request races it.
registry_wait_healthy() {
  local attempts="${1:-10}" code=000
  for _ in $(seq 1 "$attempts"); do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${PANTRY_REGISTRY_URL}/health" || echo 000)
    [[ "$code" == "200" ]] && { echo "    Healthy (HTTP 200)."; return 0; }
    sleep 3
  done
  echo "    Warning: ${PANTRY_REGISTRY_URL}/health returned $code" >&2
  return 1
}
