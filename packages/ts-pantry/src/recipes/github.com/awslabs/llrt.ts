import type { Recipe } from '../../../../scripts/recipe-types'

// llrt ships official prebuilt release binaries for every platform we target.
// Each release publishes `llrt-<platform>.zip` containing a single `llrt` binary.
// Release tags carry a `-beta` suffix (e.g. v0.8.1-beta) while our registered
// versions are bare (0.8.1). Download the official asset instead of building
// from source (which required rustup nightly + yarn + git submodules).
export const recipe: Recipe = {
  domain: 'github.com/awslabs/llrt',
  name: 'llrt',
  programs: [
    'llrt',
  ],
  versionSource: {
    // The tag is `v0.9.0-beta`; the script below re-appends `-beta` to build
    // the download URL, so the catalog must hold the BARE version. Without
    // this pattern the default v-strip left `0.9.0-beta` in the catalog and
    // the URL became `v0.9.0-beta-beta`, which 404s — every llrt version
    // published after the pattern was dropped failed on every platform.
    type: 'github-releases',
    repo: 'awslabs/llrt',
    tagPattern: /^v(\d+\.\d+\.\d+)-beta$/,
  },
  build: {
    script: [
      'VERSION={{version}}',
      'case {{hw.platform}}+{{hw.arch}} in',
      '  darwin+aarch64) PLATFORM="darwin-arm64" ;;',
      '  darwin+x86-64)  PLATFORM="darwin-x64" ;;',
      '  linux+aarch64)  PLATFORM="linux-arm64" ;;',
      '  linux+x86-64)   PLATFORM="linux-x64" ;;',
      'esac',
      '',
      'URL="https://github.com/awslabs/llrt/releases/download/v${VERSION}-beta/llrt-${PLATFORM}.zip"',
      'curl -Lfo llrt.zip "$URL"',
      'unzip -o llrt.zip',
      'install -Dm755 llrt {{prefix}}/bin/llrt',
    ],
  },
  test: {
    // Note: upstream's prebuilt binary is not always version-bumped (e.g. the
    // v0.8.1-beta release ships a binary that reports v0.8.0-beta), so only
    // assert that the binary runs rather than matching the exact version.
    script: [
      'llrt --version',
    ],
  },
}
