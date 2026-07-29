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

# Detect platform
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)
if [ "$ARCH" = "arm64" ] || [ "$ARCH" = "aarch64" ]; then
  ARCH="arm64"
else
  ARCH="x86-64"
fi
PLATFORM="${OS}-${ARCH}"

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

# Step 3: Upload
# Desktop apps/fonts produce a platform-agnostic artifact (a zip-extracted
# .app bundle or font files) but are built on a single runner — so the artifact
# dir is tagged with only the build host's platform (e.g. linux-x86-64 on the
# ubuntu runner). The Zig CLI's registry lookup only matches the *client's* own
# darwin-<arch> key, so we must register the artifact under every platform the
# recipe targets. Derive those keys from the recipe; fall back to the build
# host's platform when the recipe declares none (source-built CLI packages).
RECIPE_PLATFORMS="$(bun scripts/recipe-platforms.ts "${PACKAGE}" 2>/dev/null || true)"
PLATFORMS_ARG=()
if [ -n "${RECIPE_PLATFORMS}" ]; then
  PLATFORMS_CSV="$(echo "${RECIPE_PLATFORMS}" | tr ' ' ',')"
  PLATFORMS_ARG=(--platforms "${PLATFORMS_CSV}")
  echo "Publishing under recipe-declared platforms: ${PLATFORMS_CSV}"
fi

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
rm -rf "${BUILD_DIR}" "${INSTALL_DIR}"

echo ""
echo "============================================================"
echo "Done! ${PACKAGE}@${VERSION} published through ${PANTRY_REGISTRY_URL:-https://registry.pantry.dev}"
echo "============================================================"
