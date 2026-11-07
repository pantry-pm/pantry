import type { Recipe } from '../../../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'bitwarden.com/desktop', name: 'Bitwarden',
  description: 'The Bitwarden desktop password manager.', homepage: 'https://bitwarden.com',
  programs: [], platforms: ['darwin/aarch64'],
  versionSource: { type: 'github-releases', repo: 'bitwarden/clients', tagPattern: /^desktop-v(\d+(?:\.\d+){2})$/ },
  build: {
    script: [
      'curl -fSL --retry 3 "https://github.com/bitwarden/clients/releases/download/desktop-v{{version}}/Bitwarden-{{version}}-universal-mac.zip" -o bitwarden.zip',
      'unzip -qo bitwarden.zip',
      'mkdir -p "{{prefix}}"',
      'mv Bitwarden.app "{{prefix}}/Bitwarden.app"',
    ],
    skip: ['fix-machos'],
  },
}
