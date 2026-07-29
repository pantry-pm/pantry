#!/bin/bash
set -euo pipefail

# Populate the pantry registry with desktop fonts.
#
# For each font recipe in src/recipes/*.font.ts, resolve the latest upstream
# version and publish its artifact via build-and-upload.sh. Fonts are
# universal, but the registry stores per-platform; this publishes for the
# platform it runs on (run on macOS arm64/x86-64 to cover Macs).
#
# Requires a registry operator token in the environment (same as any
# `build-and-upload.sh` run) and `gh`/`curl` for version resolution.
#
#   ./scripts/publish-fonts.sh                 # all fonts
#   ./scripts/publish-fonts.sh inter.font      # one font
#   BUCKET=pantry-registry REGION=us-east-1 ./scripts/publish-fonts.sh

cd "$(dirname "$0")/.."
BUCKET="${BUCKET:-pantry-registry}"
REGION="${REGION:-us-east-1}"

# domain | github repo | strip-leading-v (1=yes,0=no)
FONTS=(
  "inter.font|rsms/inter|1"
  "meslo-lg-nerd-font.font|ryanoasis/nerd-fonts|1"
  "jetbrains-mono.font|JetBrains/JetBrainsMono|1"
  "jetbrains-mono-nerd-font.font|ryanoasis/nerd-fonts|1"
  "cascadia-code.font|microsoft/cascadia-code|1"
  "fira-code.font|tonsky/FiraCode|0"
  "hack.font|source-foundry/Hack|1"
)

latest_tag() {
  curl -fsSL "https://api.github.com/repos/$1/releases/latest" \
    | python3 -c "import sys,json;print(json.load(sys.stdin)['tag_name'])"
}

only="${1:-}"
published=0
for entry in "${FONTS[@]}"; do
  IFS='|' read -r domain repo strip <<< "$entry"
  [ -n "$only" ] && [ "$only" != "$domain" ] && continue

  tag="$(latest_tag "$repo")" || { echo "! $domain: could not resolve version" >&2; continue; }
  version="$tag"
  [ "$strip" = "1" ] && version="${tag#v}"

  echo "==> Publishing $domain @ $version (from $repo)"
  ./scripts/build-and-upload.sh "$domain" "$version" "$BUCKET" "$REGION"
  published=$((published + 1))
done

echo "Done. Published $published font(s) through ${PANTRY_REGISTRY_URL:-https://registry.pantry.dev}"
