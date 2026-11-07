#!/bin/bash
set -euo pipefail

# Build and publish a package through the registry scan gate
# Usage: ./scripts/build-and-upload.sh <package> <version> [bucket] [region]
# Example: ./scripts/build-and-upload.sh php.net 8.4.11 my-bucket us-east-1

# Anchor to the ts-pantry package root (this script lives in scripts/) so the
# relative `bun scripts/...` invocations and the artifacts directory resolve the
# same way no matter what directory the caller runs us from. Without this, the
# tar step below (which used a relative ./artifacts path after cd-ing into the
# install dir) wrote to a non-existent path and failed.
cd "$(dirname "$0")/.."
REPO_DIR="$(pwd)"

PACKAGE="${1:?Usage: $0 <package> <version> [bucket] [region]}"
VERSION="${2:?Usage: $0 <package> <version> [bucket] [region]}"
BUCKET="${3:-pantry-registry}"
REGION="${4:-us-east-1}"

# Desktop callers pass the actual target explicitly. A Linux runner can repackage
# an upstream Mac ZIP, but must never label that Mach-O as a Linux artifact.
if [ -n "${5:-}" ]; then
  PLATFORM="$5"
else
  OS=$(uname -s | tr '[:upper:]' '[:lower:]')
  ARCH=$(uname -m)
  if [ "$ARCH" = "arm64" ] || [ "$ARCH" = "aarch64" ]; then ARCH="arm64"; else ARCH="x86-64"; fi
  PLATFORM="${OS}-${ARCH}"
fi
case "$PLATFORM" in
  darwin-arm64|linux-arm64|linux-x86-64) ;;
  *) echo "Unsupported publication target: $PLATFORM" >&2; exit 1 ;;
esac

# Slash-domains (e.g. "logitech.com/options-plus") must not leak their slash into
# filesystem paths or the tarball name — otherwise the artifact/tarball paths gain
# a spurious nested directory and tar/upload break. Sanitize to a flat name for all
# on-disk paths (matching upload-to-s3.ts, which expects <pkg-with-dashes>-<ver>.tar.gz).
# The real $PACKAGE (with slash) is still passed to build/upload as the package id.
SAFE_PACKAGE="${PACKAGE//\//-}"

# Directories (ARTIFACTS_DIR is absolute so it survives any cd)
BUILD_DIR="/tmp/pantry-build/${SAFE_PACKAGE}-${VERSION}"
INSTALL_DIR="/tmp/pantry-install/${SAFE_PACKAGE}-${VERSION}"
ARTIFACTS_DIR="${REPO_DIR}/artifacts"
ARTIFACT_NAME="${SAFE_PACKAGE}-${VERSION}-${PLATFORM}"
ARTIFACT_DIR="${ARTIFACTS_DIR}/${ARTIFACT_NAME}"

echo "============================================================"
echo "Building ${PACKAGE}@${VERSION} for ${PLATFORM}"
echo "============================================================"
echo "Build dir: ${BUILD_DIR}"
echo "Install dir: ${INSTALL_DIR}"
echo "Artifacts dir: ${ARTIFACT_DIR}"
echo "Bucket: ${BUCKET}"
echo "Region: ${REGION}"
echo ""

# Clean up previous builds
rm -rf "${BUILD_DIR}" "${INSTALL_DIR}" "${ARTIFACT_DIR}"
mkdir -p "${BUILD_DIR}" "${INSTALL_DIR}" "${ARTIFACT_DIR}"

# Step 1: Build
echo ""
echo ">>> Step 1: Building from source..."
bun scripts/build-package.ts \
  --package "${PACKAGE}" \
  --version "${VERSION}" \
  --platform "${PLATFORM}" \
  --build-dir "${BUILD_DIR}" \
  --prefix "${INSTALL_DIR}"

# Guard: the build must have produced something to package.
if [ -z "$(ls -A "${INSTALL_DIR}" 2>/dev/null)" ]; then
  echo "❌ Build produced no files in ${INSTALL_DIR}; aborting before upload." >&2
  exit 1
fi

# Step 2: Package (tar -C avoids cd, and all paths are absolute)
echo ""
echo ">>> Step 2: Creating tarball..."
TARBALL="${SAFE_PACKAGE}-${VERSION}.tar.gz"
tar -czf "${ARTIFACT_DIR}/${TARBALL}" -C "${INSTALL_DIR}" .

# Generate SHA256 (subshell keeps the cwd change local)
( cd "${ARTIFACT_DIR}" && shasum -a 256 "${TARBALL}" > "${TARBALL}.sha256" )

echo "Created: ${ARTIFACT_DIR}/${TARBALL}"
echo "SHA256: $(cat "${ARTIFACT_DIR}/${TARBALL}.sha256")"

# Register only the architecture actually downloaded and verified. Recipes may
# declare multiple platforms, but architecture-specific bytes cannot be fanned out.
PLATFORMS_ARG=(--platforms "$PLATFORM")

echo ""
echo ">>> Step 3: Staging, scanning, and publishing..."
bun scripts/upload-to-s3.ts \
  --package "${PACKAGE}" \
  --version "${VERSION}" \
  --artifacts-dir "${ARTIFACTS_DIR}" \
  --bucket "${BUCKET}" \
  --region "${REGION}" \
  ${PLATFORMS_ARG[@]+"${PLATFORMS_ARG[@]}"}

# Cleanup
echo ""
echo ">>> Cleaning up build directories..."
rm -rf "${BUILD_DIR}" "${INSTALL_DIR}" "${ARTIFACT_DIR}"

echo ""
echo "============================================================"
echo "Done! ${PACKAGE}@${VERSION} published through ${PANTRY_REGISTRY_URL:-https://registry.pantry.dev}"
echo "============================================================"
