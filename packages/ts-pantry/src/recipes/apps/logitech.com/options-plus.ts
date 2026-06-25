import type { Recipe } from '../../../../scripts/recipe-types'

// Desktop app — installs natively from pantry's registry into /Applications
// (see zig/src/install/native_apps.zig).
//
// Logi Options+ ships a rolling installer zip with NO version in the URL
// (logioptionsplus_installer.zip is always "latest"). Logitech publishes no
// public version manifest (probed: all 404) and the zip carries no version in
// its filename/headers, so there is no official feed to auto-resolve from.
// We therefore PIN the version (no Homebrew); the rolling installer keeps the
// binary itself current on any rebuild. Bump this string manually on a notable
// Options+ release (it updates infrequently).
export const recipe: Recipe = {
  domain: 'logitech.com/options-plus',
  name: 'Logi Options+',
  description: 'Logitech device customization and settings application.',
  homepage: 'https://www.logitech.com/software/logi-options-plus.html',
  programs: [],
  platforms: ['darwin/aarch64', 'darwin/x86-64'],
  versionSource: {
    type: 'custom',
    fetch: async (): Promise<string[]> => ['2.3.879545'],
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
