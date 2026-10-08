import type { Recipe } from '../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'yt-dlp.org',
  name: 'yt-dlp',
  description: 'A feature-rich command-line audio/video downloader',
  homepage: 'https://github.com/yt-dlp/yt-dlp',
  github: 'https://github.com/yt-dlp/yt-dlp',
  programs: ['yt-dlp'],
  versionSource: {
    type: 'github-releases',
    repo: 'yt-dlp/yt-dlp',
  },
  distributable: {
    url: 'https://github.com/yt-dlp/yt-dlp/releases/download/{{version.raw}}/yt-dlp.tar.gz',
    stripComponents: 1,
  },

  // A Python zipapp: it runs on any Python 3.10+, and pulls in ffmpeg to
  // merge the best video and audio streams into one file.
  dependencies: {
    'python.org': '>=3.10<3.15',
    'ffmpeg.org': '*',
  },

  build: {
    script: [
      'mkdir -p {{prefix}}/bin {{prefix}}/libexec',
      'cp yt-dlp {{prefix}}/libexec/yt-dlp',
      // The zipapp's own `#!/usr/bin/env python3` takes whatever python3 is
      // first on PATH: on a Mac that is Xcode's 3.9, which yt-dlp refuses
      // ("Only Python versions 3.10 and above are supported"). The launcher
      // runs it with the Python installed beside it, found relative to
      // itself so the package stays relocatable.
      [
        'cat > {{prefix}}/bin/yt-dlp <<\'LAUNCHER\'',
        '#!/bin/sh',
        's=$0',
        'while [ -h "$s" ]; do l=$(readlink "$s"); case $l in /*) s=$l ;; *) s=${s%/*}/$l ;; esac; done',
        'here=$(cd "${s%/*}/.." && pwd)',
        'for py in "$here"/../../python.org/v3/bin/python3 "$here"/../../python.org/v3.*/bin/python3; do',
        '  [ -x "$py" ] && exec "$py" "$here/libexec/yt-dlp" "$@"',
        'done',
        'exec python3 "$here/libexec/yt-dlp" "$@"',
        'LAUNCHER',
      ].join('\n'),
      'chmod +x {{prefix}}/bin/yt-dlp',
    ],
  },
}
