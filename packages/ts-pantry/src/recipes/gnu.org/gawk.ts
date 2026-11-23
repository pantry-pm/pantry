import type { Recipe } from '../../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'gnu.org/gawk',
  name: 'gawk',
  revisions: { '5.4.0': 1 },
  revisionReasons: { '5.4.0': 'elf-loader-paths' },
  programs: [
    'awk',
    'gawk',
    'gawk-{{version}}',
    'gawkbug',
  ],
  distributable: {
    url: 'https://ftp.gnu.org/gnu/gawk/gawk-{{ version.raw }}.tar.gz',
    stripComponents: 1,
  },
  build: {
    script: [
      './configure --prefix={{ prefix }}',
      'make --jobs {{ hw.concurrency }} install',
    ],
  },
  test: {
    script: [
      'test "$(echo "Goodbye, cruel World" | gawk \'{ gsub("Goodbye, cruel", "Hello,"); print }\')" = "Hello, World"',
    ],
  },
}
