import type { Recipe } from '../../../../scripts/recipe-types'

// Desktop app — installs natively from pantry's registry into /Applications
// (see zig/src/install/native_apps.zig).
//
// Logi Options+ ships a rolling installer zip with NO version in the URL
// (logioptionsplus_installer.zip is always "latest"), but it IS a Homebrew cask
// (`logi-options+`). Homebrew tracks the current version (e.g. 2.1.854976), kept
// fresh by its livecheck/autobump — so we resolve the latest version from the
// Cask API and the daily updater auto-republishes new releases. The download URL
// is rolling, so the build keeps using it directly.
export const recipe: Recipe = {
  domain: 'logitech.com/options-plus',
  name: 'Logi Options+',
  description: 'Logitech device customization and settings application.',
  homepage: 'https://www.logitech.com/software/logi-options-plus.html',
  programs: [],
  platforms: ['darwin/aarch64', 'darwin/x86-64'],
  // Auto-update via the Homebrew cask's tracked version.
  versionSource: {
    type: 'homebrew-cask',
    cask: 'logi-options+',
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
