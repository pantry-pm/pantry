#!/usr/bin/env bash
# Install (or reinstall) the pantry-mac-self-hosted GitHub Actions runner on an
# Apple-silicon Mac, as the current user, as a launchd LaunchAgent.
#
#   .github/self-hosted-runner/install-macos.sh [runner-version]
#
# Needs: gh authenticated as a pantry-pm/pantry admin. No sudo: the runner runs
# as the logged-in user, never as root. The LaunchAgent starts at login, so the
# Mac must be logged in (or set to log in automatically) after a reboot.
#
# What it sets up:
#   * the official actions/runner osx-arm64 release, its SHA-256 checked against
#     both the release asset digest and the hash in the release notes;
#   * registration to pantry-pm/pantry with ONLY the label pantry-mac-self-hosted
#     (--no-default-labels, so a stray `runs-on: self-hosted`/`macOS` never lands
#     here);
#   * job-started.sh / job-completed.sh copied into the runner directory and wired
#     as ACTIONS_RUNNER_HOOK_JOB_STARTED / _COMPLETED: event/ref/workflow gate,
#     free-space guard, cleanup after every job;
#   * BUILDKIT_ROOT pointed at the runner-owned /tmp/pantry-runner so cleanup
#     never touches other work on this Mac. (Keep it two levels deep, like
#     /mnt/buildkit on Linux: buildkit derives PKGX_DIR from the first two path
#     components of a dependency prefix.)
set -euo pipefail

repo="pantry-pm/pantry"
label="pantry-mac-self-hosted"
runner_dir="${PANTRY_RUNNER_DIR:-$HOME/actions-runners/pantry}"
min_free_gb="${PANTRY_MIN_FREE_GB:-12}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

[ "$(uname -s)-$(uname -m)" = "Darwin-arm64" ] || { echo "Apple-silicon macOS only" >&2; exit 1; }
[ "$(id -u)" != 0 ] || { echo "Run as your own user, not root" >&2; exit 1; }

version="${1:-$(gh api repos/actions/runner/releases/latest --jq .tag_name)}"
version="${version#v}"
asset="actions-runner-osx-arm64-${version}.tar.gz"

release=$(gh api "repos/actions/runner/releases/tags/v${version}")
digest=$(jq -r --arg n "$asset" '.assets[] | select(.name == $n) | .digest' <<<"$release")
digest="${digest#sha256:}"
notes_sha=$(jq -r .body <<<"$release" | sed -n 's/.*<!-- BEGIN SHA osx-arm64 -->\([0-9a-f]\{64\}\)<!-- END SHA osx-arm64 -->.*/\1/p')
[ -n "$digest" ] && [ "$digest" = "$notes_sha" ] || { echo "Release digest ($digest) and release-notes SHA ($notes_sha) disagree" >&2; exit 1; }

download=$(mktemp -d)
trap 'rm -rf "$download"' EXIT
curl -fsSL -o "$download/$asset" "https://github.com/actions/runner/releases/download/v${version}/${asset}"
actual=$(shasum -a 256 "$download/$asset" | awk '{ print $1 }')
[ "$actual" = "$digest" ] || { echo "Checksum mismatch: got $actual, expected $digest" >&2; exit 1; }
echo "actions/runner ${version}: sha256 ${actual} verified"

if [ -f "$runner_dir/.runner" ]; then
  echo "Removing the existing registration in $runner_dir"
  (cd "$runner_dir" && ./svc.sh stop >/dev/null 2>&1 || true; ./svc.sh uninstall >/dev/null 2>&1 || true)
  remove_token=$(gh api -X POST "repos/$repo/actions/runners/remove-token" --jq .token)
  (cd "$runner_dir" && ./config.sh remove --token "$remove_token") || true
fi
mkdir -p "$runner_dir"
tar -xzf "$download/$asset" -C "$runner_dir"

install -m 0755 "$here/job-started.sh" "$runner_dir/job-started.sh"
install -m 0755 "$here/job-completed.sh" "$runner_dir/job-completed.sh"

token=$(gh api -X POST "repos/$repo/actions/runners/registration-token" --jq .token)
(cd "$runner_dir" && ./config.sh --unattended --replace \
  --url "https://github.com/$repo" --token "$token" \
  --name "$(scutil --get LocalHostName)-pantry" \
  --no-default-labels --labels "$label" --work _work)

# config.sh snapshots the installing shell into .env and .path: its PATH (dev
# builds, global Pantry packages) and variables like JAVA_HOME. Builds must see
# what a hosted runner sees, not a developer's shell, so both are rewritten: the
# system PATH only (each job installs Pantry, Bun and the native toolchain
# through ./packages/action), and the runner policy. TMPDIR is not set here:
# the listener itself uses it, and the job-started hook empties the build root.
# The workflows point TMPDIR at $RUNNER_TEMP, which the runner owns.
echo "/usr/bin:/bin:/usr/sbin:/sbin" >"$runner_dir/.path"
{
  echo "LANG=en_US.UTF-8"
  echo "ACTIONS_RUNNER_HOOK_JOB_STARTED=$runner_dir/job-started.sh"
  echo "ACTIONS_RUNNER_HOOK_JOB_COMPLETED=$runner_dir/job-completed.sh"
  echo "BUILDKIT_ROOT=/tmp/pantry-runner"
  echo "PANTRY_MIN_FREE_GB=$min_free_gb"
} >"$runner_dir/.env"

(cd "$runner_dir" && ./svc.sh install && ./svc.sh start && ./svc.sh status)
