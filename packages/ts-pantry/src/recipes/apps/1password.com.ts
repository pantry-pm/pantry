import type { Recipe } from '../../../scripts/recipe-types'
import { textVersionSource } from '../../../scripts/desktop-version-sources'

export const recipe: Recipe = {
  domain: '1password.com',
  name: '1Password',
  description: 'A password manager and secure vault.',
  homepage: 'https://1password.com',
  programs: ['1password'],
  platforms: ['darwin/aarch64', 'darwin/x86-64', 'windows/x64'],

  versionSource: textVersionSource('https://releases.1password.com/mac/stable/', /1Password for Mac (\d+(?:\.\d+){1,3})/),

  build: {
    script: [
      'if test {{hw.arch}} = "aarch64"; then ARCH="aarch64"; else ARCH="x86_64"; fi',
      'curl -fSL "https://downloads.1password.com/mac/1Password-{{version}}-${ARCH}.zip" -o /tmp/1password.zip',
      'cd /tmp && unzip -qo 1password.zip',
      'mkdir -p {{prefix}}',
      'mv "/tmp/1Password.app" {{prefix}}/1Password.app',
      'mkdir -p {{prefix}}/bin',
      'ln -sf "../1Password.app/Contents/MacOS/1Password" {{prefix}}/bin/1password',
    ],
  },
}
