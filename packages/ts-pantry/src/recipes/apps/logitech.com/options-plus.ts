import type { Recipe } from '../../../scripts/recipe-types'

// Desktop app — installs natively from pantry's registry into /Applications
// (see zig/src/install/native_apps.zig). No Homebrew.
//
// Logi Options+ ships a rolling installer zip with NO version in the URL
// (logioptionsplus_installer.zip is always "latest"). The published version
// (2.3.879545) is the installer .app's CFBundleVersion. With no clean version
// feed, the version is PINNED — the daily updater tracks it at the published
// version (no auto-bump). The install is the installer .app itself (Logitech
// distributes the app via this stub installer).
export const recipe: Recipe = {
  domain: 'logitech.com/options-plus',
  name: 'Logi Options+',
  description: 'Logitech device customization and settings application.',
  homepage: 'https://www.logitech.com/software/logi-options-plus.html',
  programs: [],
  platforms: ['darwin/aarch64', 'darwin/x86-64'],
  // Rolling installer, no version in the URL — pinned.
  versionSource: {
    type: 'url-pattern',
    url: 'https://download01.logi.com/web/ftp/pub/techsupport/optionsplus/logioptionsplus_installer.zip',
    knownVersions: ['2.3.879545'],
  },
  distributable: null,

  build: {
    script: [
      'curl -fSL -L -H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" "https://download01.logi.com/web/ftp/pub/techsupport/optionsplus/logioptionsplus_installer.zip" -o /tmp/logi.zip',
      'cd /tmp && rm -rf logi-x && mkdir -p logi-x && unzip -qo logi.zip -d logi-x',
      'mkdir -p {{prefix}}',
      'src_app="$(find /tmp/logi-x -maxdepth 2 -name "logioptionsplus_installer.app" -not -path "*/__MACOSX/*" | head -1)" && cp -R "$src_app" {{prefix}}/logioptionsplus_installer.app',
    ],
  },
}
