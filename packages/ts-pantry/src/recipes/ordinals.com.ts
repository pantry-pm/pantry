import type { Recipe } from '../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'ordinals.com',
  name: 'ord',
  description: 'Index, block explorer, and command-line wallet',
  homepage: 'https://ordinals.com/',
  github: 'https://github.com/ordinals/ord',
  programs: ['ord'],
  platforms: ['darwin/aarch64', 'linux/x86-64'],
  // casey/ord is a FORK with no releases and no tags, so this resolved nothing
  // and the package froze. The `github:` field above and the download URL below
  // both already point at ordinals/ord — only the version source disagreed.
  versionSource: {
    type: 'github-releases',
    repo: 'ordinals/ord',
  },

  build: {
    script: [
      // {{hw.platform}}/{{hw.arch}} is the TARGET, `uname` is the host. This
      // cased on uname, so a darwin-arm64 build on an ubuntu runner took the
      // Linux branch, downloaded a Linux binary and published it under the
      // darwin-arm64 key — caught only by verifyForeignArtifact, which failed
      // it five times a sweep. A download recipe must case on the target or it
      // cannot be produced from any box, which is the whole point of one.
      'case {{hw.platform}}/{{hw.arch}} in',
      '  darwin/aarch64) SUFFIX="aarch64-apple-darwin" ;;',
      '  linux/x86-64)   SUFFIX="x86_64-unknown-linux-gnu" ;;',
      '  *) echo "Unsupported: {{hw.platform}}/{{hw.arch}}" >&2; exit 42 ;;',
      'esac',
      'mkdir -p {{prefix}}/bin /tmp/ord-extract',
      'curl -fSL "https://github.com/ordinals/ord/releases/download/{{version}}/ord-{{version}}-${SUFFIX}.tar.gz" | tar xz -C /tmp/ord-extract',
      'cp "$(find /tmp/ord-extract -name ord -type f | head -1)" {{prefix}}/bin/ord',
      'chmod +x {{prefix}}/bin/ord',
    ],
  },
}
