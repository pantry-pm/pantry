import type { Recipe } from '../../../scripts/recipe-types'

/**
 * A Bun release of stacksjs/bun is tagged `bun-v<official>-stacks.<n>`: the
 * official release it was built from, and which of our builds of it this is.
 * Pantry versions are numeric, so `bun-v1.4.4-stacks.1` is `1.4.4.1` here, and
 * `^1.4.4` or `1.4.4.1` both select it. The last component is ours, the rest
 * is the official version the binary reports from `bun --version`.
 */
export const releaseTagPattern: RegExp = /^bun-v(\d+\.\d+\.\d+)-stacks\.(\d+)$/

// The tag, back from the version. `{{version}}` is all the build is given.
const tagFromVersion = [
  'VERSION="{{version}}"',
  'OFFICIAL="${VERSION%.*}"',
  'BUILD="${VERSION##*.}"',
  'TAG="bun-v${OFFICIAL}-stacks.${BUILD}"',
]

export const recipe: Recipe = {
  domain: 'stacksjs.com/bun',
  name: 'stacks-bun',
  description: 'Bun with MySQL and Postgres calls that answer where they are written: query.wait(), executeSync(), cancelSync() and sql.reserveSync(). Official Bun plus those changes, built by stacksjs/bun.',
  homepage: 'https://github.com/stacksjs/bun#readme',
  github: 'https://github.com/stacksjs/bun',
  // The same programs as bun.com: a project installs one or the other.
  programs: ['bun', 'bunx'],
  // What stacksjs/bun builds. A target it does not build has no asset to take.
  platforms: ['darwin/aarch64', 'linux/x86-64'],
  versionSource: {
    type: 'github-releases',
    repo: 'stacksjs/bun',
    tagPattern: releaseTagPattern,
    stable: true,
  },
  // Prebuilt download, like bun.com: the release carries per-platform zips.
  distributable: null,
  buildDependencies: {
    'curl.se': '*',
    'info-zip.org/unzip': '*',
    'gnu.org/coreutils': '*',
  },

  build: {
    script: [
      'case {{hw.platform}}+{{hw.arch}} in',
      '  darwin+aarch64) ASSET="bun-darwin-aarch64" ;;',
      '  linux+x86-64)   ASSET="bun-linux-x64"      ;;',
      '  *) echo "stacksjs/bun builds no {{hw.platform}}+{{hw.arch}} binary" >&2; exit 42 ;;',
      'esac',
      '',
      ...tagFromVersion,
      // bun-v1.4.4-stacks.1 was built on a runner with glibc 2.43, and its
      // Linux binary starts nowhere older: not on Ubuntu 24.04, and not on the
      // floor this registry publishes for. It is a release Linux does not
      // have, which is what 42 says, so the next build is taken instead of
      // this one being tried again. The macOS binary of it is fine.
      'if [ "{{hw.platform}}" = linux ] && [ "$VERSION" = 1.4.4.1 ]; then',
      '  echo "stacksjs/bun $TAG has no Linux binary that starts on glibc 2.39" >&2; exit 42',
      'fi',
      'RELEASE="https://github.com/stacksjs/bun/releases/download/${TAG}"',
      'curl -fSL --connect-timeout 30 --max-time 600 "$RELEASE/${ASSET}.zip" -o "${ASSET}.zip"',
      'curl -fSL --connect-timeout 30 --max-time 300 "$RELEASE/SHASUMS256.txt" -o SHASUMS256.txt',
      // Exactly one well-formed line for this asset, or nothing is installed.
      'awk -v name="${ASSET}.zip" \'$2 == name { if (NF != 2 || length($1) != 64 || $1 ~ /[^0-9a-fA-F]/) exit 1; print; found++ } END { if (found != 1) exit 1 }\' SHASUMS256.txt > artifact.sha256',
      'sha256sum --check artifact.sha256',
      // `-j` flattens the `bun-<triple>/` directory the zip wraps everything in.
      'unzip -qj "${ASSET}.zip" "${ASSET}/bun"',
      'install -Dm755 bun "{{prefix}}/bin/bun"',
      // Relative, so the link survives the tarball being unpacked anywhere.
      'ln -sf bun "{{prefix}}/bin/bunx"',
    ],
    // Bun's self-contained executable carries embedded data; keep it as built.
    skip: ['fix-patchelf'],
  },
  test: {
    required: true,
    script: [
      ...tagFromVersion,
      'test "$(bun --version)" = "$OFFICIAL"',
      // Official Bun passes the line above too. Only this build has the calls,
      // and a query that was never started needs no database to be asked.
      'bun -e \'const sql = new Bun.SQL("postgres://pantry@127.0.0.1:1/pantry"); const query = sql.unsafe("select 1"); for (const [name, value] of [["sql.reserveSync", sql.reserveSync], ["query.wait", query.wait], ["query.executeSync", query.executeSync], ["query.cancelSync", query.cancelSync]]) { if (typeof value !== "function") { console.error(name + " is missing: this is not a stacksjs/bun build"); process.exit(1) } }\'',
    ],
  },
}
