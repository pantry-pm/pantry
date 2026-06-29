import type { Recipe } from '../../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'figma.com',
  name: 'Figma',
  description: 'A collaborative interface design tool.',
  homepage: 'https://figma.com',
  programs: ['figma'],
  platforms: ['darwin/aarch64', 'darwin/x86-64', 'windows/x64'],

  build: {
    script: [
      'if test {{hw.arch}} = "aarch64"; then ARCH="mac-arm"; else ARCH="mac"; fi',
      'curl -fSL "https://desktop.figma.com/${ARCH}/Figma-{{version}}.zip" -o /tmp/figma.zip',
      'cd /tmp && unzip -qo figma.zip',
      'mkdir -p {{prefix}}',
      'mv "/tmp/Figma.app" {{prefix}}/Figma.app',
      'mkdir -p {{prefix}}/bin',
      'ln -sf "../Figma.app/Contents/MacOS/Figma" {{prefix}}/bin/figma',
    ],
  },
}
