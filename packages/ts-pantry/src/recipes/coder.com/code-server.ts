import type { Recipe } from '../../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'coder.com/code-server',
  name: 'code-server',
  programs: [
    'code-server',
  ],
  github: 'https://github.com/coder/code-server',
  versionSource: {
    type: 'github-releases',
    repo: 'coder/code-server',
    tagPattern: /^v(.+)$/,
  },
  distributable: undefined,
  build: {
    script: [
      'curl -L "$DIST_URL" -o code-server.tar.gz',
      'tar xzf code-server.tar.gz --strip-components=1 -C "{{prefix}}"',
      // The release tree carries native add-ons for every platform its npm
      // dependencies support. A glibc Linux host loads none of the musl,
      // FreeBSD, s390x or ppc64 ones, and each names a C library or loader
      // this package cannot declare (libc.musl-*.so.1, libthr.so.3,
      // ld64.so.1, ld64.so.2). The paths are the ones the 4.145.2
      // publication failure named, matched narrowly: a static musl build
      // that glibc hosts do run (ripgrep) must stay.
      {
        run: [
          'find "{{prefix}}" -type d \\( -path \'*/argon2/prebuilds/freebsd-*\' -o -path \'*/@parcel/watcher-*-musl\' -o -path \'*/@koromix/koffi-*/musl_*\' -o -path \'*/ripgrep-universal/bin/linux-s390x\' -o -path \'*/ripgrep-universal/bin/linux-ppc64*\' \\) -prune -exec rm -rf {} +',
          'find "{{prefix}}" -type f -path \'*/argon2/prebuilds/*\' -name \'*.musl.node\' -delete',
          // The Microsoft sign-in extension's native broker links a desktop
          // WebKitGTK stack (libwebkit2gtk-4.1, libgtk-3, libsecret, D-Bus):
          // a closure a browser-hosted editor cannot use, and one the broker
          // already fails to load without on a headless host.
          'rm -f "{{prefix}}/lib/vscode/extensions/microsoft-authentication/dist/libmsalruntime.so" "{{prefix}}/lib/vscode/extensions/microsoft-authentication/dist/msal-node-runtime.node"',
        ],
        if: 'linux',
      },
    ],
    env: {
      'linux/x86-64': {
        DIST_URL: 'https://github.com/coder/code-server/releases/download/v{{version}}/code-server-{{version}}-linux-amd64.tar.gz',
      },
      'linux/aarch64': {
        DIST_URL: 'https://github.com/coder/code-server/releases/download/v{{version}}/code-server-{{version}}-linux-arm64.tar.gz',
      },
      'darwin/x86-64': {
        DIST_URL: 'https://github.com/coder/code-server/releases/download/v{{version}}/code-server-{{version}}-macos-amd64.tar.gz',
      },
      'darwin/aarch64': {
        DIST_URL: 'https://github.com/coder/code-server/releases/download/v{{version}}/code-server-{{version}}-macos-arm64.tar.gz',
      },
    },
    // A vendored Node application: its add-ons find their sibling libraries
    // by relative path and the macOS images are vendor-signed, so the loader
    // layout is preserved rather than flattened into lib/.
    skip: [
      'verify-foreign-artifact',
      'fix-patchelf',
      'fix-machos',
    ],
  },
  test: {
    script: [
      'code-server --version | grep {{version}}',
    ],
  },
}
