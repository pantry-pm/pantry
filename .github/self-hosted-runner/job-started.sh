#!/usr/bin/env bash
# ACTIONS_RUNNER_HOOK_JOB_STARTED for the pantry-mac-self-hosted runner.
#
# The runner executes this from its own install directory before the first
# step of every job, so a workflow file (or a pull request that edits one)
# cannot change it. A non-zero exit fails the job before any of its steps run.
#
#   1. Gate: pantry-pm/pantry is public. Only jobs from the build workflows on
#      main, started by a push to main or a workflow_dispatch of main, may run
#      here. A pull_request job that names this label is refused even if a
#      maintainer approves the run.
#   2. Sweep whatever an interrupted job left in the runner's own build root.
#   3. Disk guard: refuse to start below PANTRY_MIN_FREE_GB, because this Mac
#      also runs Chris's other work and a full disk breaks all of it.
set -euo pipefail

min_free_gb="${PANTRY_MIN_FREE_GB:-12}"
build_root="${BUILDKIT_ROOT:-/tmp/pantry-runner}"
allowed_workflows=(
  "pantry-pm/pantry/.github/workflows/build.yml@refs/heads/main"
  "pantry-pm/pantry/.github/workflows/publish-changed-packages.yml@refs/heads/main"
)

refuse() {
  echo "::error::pantry-mac-self-hosted refused this job: $*"
  exit 1
}

[ "${GITHUB_REPOSITORY:-}" = "pantry-pm/pantry" ] || refuse "repository '${GITHUB_REPOSITORY:-}' is not pantry-pm/pantry"
case "${GITHUB_EVENT_NAME:-}" in
  push|workflow_dispatch) ;;
  *) refuse "event '${GITHUB_EVENT_NAME:-}' is not push or workflow_dispatch" ;;
esac
[ "${GITHUB_REF:-}" = "refs/heads/main" ] || refuse "ref '${GITHUB_REF:-}' is not refs/heads/main"
workflow_ok=false
for allowed in "${allowed_workflows[@]}"; do
  [ "${GITHUB_WORKFLOW_REF:-}" = "$allowed" ] && workflow_ok=true
done
$workflow_ok || refuse "workflow '${GITHUB_WORKFLOW_REF:-}' is not an allowed build workflow on main"

# The build root belongs to this runner alone (other sessions on this Mac use
# their own /tmp paths), so anything in it is stale from an interrupted job.
case "$build_root" in
  /tmp/pantry-runner|/private/tmp/pantry-runner) rm -rf "$build_root" ;;
  *) refuse "BUILDKIT_ROOT '$build_root' is not the runner-owned /tmp/pantry-runner" ;;
esac
mkdir -p "$build_root"

free_gb=$(df -Pk "$build_root" | awk 'NR==2 { print int($4 / 1024 / 1024) }')
echo "pantry-mac-self-hosted: ${free_gb} GB free (guard: ${min_free_gb} GB)"
if [ "$free_gb" -lt "$min_free_gb" ]; then
  refuse "only ${free_gb} GB free on $(df -Pk "$build_root" | awk 'NR==2 { print $6 }'); need ${min_free_gb} GB before starting a build"
fi
