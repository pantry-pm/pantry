#!/usr/bin/env bash
# ACTIONS_RUNNER_HOOK_JOB_COMPLETED for the pantry-mac-self-hosted runner.
#
# Runs after every job, successful or not, from the runner's install directory.
# It returns the disk to where it was before the job: the runner-owned build
# root (build/install/deps trees, TMPDIR) and everything under _work (the
# checkout, the job's Pantry/Bun installs and dependency-archive caches, the
# runner's temp and tool caches). Nothing outside those two places is touched,
# because this Mac also runs other work that uses /tmp and ~/.cache.
set -uo pipefail

build_root="${BUILDKIT_ROOT:-/tmp/pantry-runner}"
runner_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work_dir="$runner_dir/_work"

before=$(df -Pk / | awk 'NR==2 { print int($4 / 1024 / 1024) }')

case "$build_root" in
  /tmp/pantry-runner|/private/tmp/pantry-runner) rm -rf "$build_root" ;;
  *) echo "::warning::not removing unexpected BUILDKIT_ROOT '$build_root'" ;;
esac

# The runner recreates _work and its subdirectories for the next job. Files the
# build made read-only (Go module caches, some tarballs) need write permission
# back before they can be removed.
if [ -d "$work_dir" ]; then
  chmod -R u+w "$work_dir" 2>/dev/null || true
  find "$work_dir" -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null || true
fi

after=$(df -Pk / | awk 'NR==2 { print int($4 / 1024 / 1024) }')
echo "pantry-mac-self-hosted cleanup: ${before} GB -> ${after} GB free"
exit 0
