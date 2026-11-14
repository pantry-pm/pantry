import type { Recipe } from '../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'ffmpeg.org',
  name: 'ffmpeg',
  // 9.0.2 for darwin-arm64 was a mirrored vendor archive linked against
  // `harfbuzz.org/v8`, a release the registry does not carry, and its dylibs
  // had no Mach-O header padding: installs failed rewriting load commands, or
  // succeeded and ffmpeg could not start. Revision 1 is this recipe's own
  // build, which carries the libraries it links and proves an encode.
  revisions: { '9.0.2': 1 },
  description: 'Play, record, convert, and stream audio and video',
  homepage: 'https://ffmpeg.org/',
  github: 'https://github.com/FFmpeg/FFmpeg',
  programs: ['ffmpeg', 'ffplay', 'ffprobe'],
  versionSource: {
    type: 'github-tags',
    repo: 'FFmpeg/FFmpeg',
    tagPattern: /^n(\d+(?:\.\d+){0,3})$/,
  },
  distributable: {
    url: 'https://ffmpeg.org/releases/ffmpeg-{{version.raw}}.tar.gz',
    stripComponents: 1,
  },
  dependencies: {
    'lame.sourceforge.io': '>=3.98.3',
    'libsdl.org': '^2',
    'freetype.org': '^2',
    // HarfBuzz keeps one ABI (libharfbuzz.so.0) across majors, and the
    // registry builds 14.x; ^8 matched nothing it had.
    'harfbuzz.org': '>=8',
    'videolan.org/x264': '^0.164',
    'videolan.org/x265': '^3',
    'webmproject.org/libvpx': '~1.14',
    'opus-codec.org': '^1',
    'google.com/webp': '^1',
  },
  buildDependencies: {
    'x86-64': {
      'nasm.us': '2',
    },
  },

  build: {
    script: [
      '# --enable-libharfbuzz is not available in all versions',
      'if grep -q -- --enable-libharfbuzz configure; then',
      '  ARGS="$ARGS --enable-libharfbuzz"',
      'fi',
      '',
      '# ffmpeg configure does not honor LIBRARY_PATH/CPATH for its compile/link',
      '# probes. lame ships NO pkg-config .pc file, so --enable-libmp3lame fails',
      '# with the "libmp3lame >= 3.98.3 not found" error unless the lame',
      '# include/lib dirs are passed explicitly. libvpx is found via pkg-config but',
      '# its decoder symbol probe (vpx_codec_dec_init_ver) fails to LINK ("libvpx',
      '# enabled but no supported decoders found") without an explicit -L. Feed every',
      '# dep prefix into ffmpeg via --extra-cflags / --extra-ldflags so all',
      '# detection probes resolve regardless of pkg-config availability.',
      '#',
      '# x264/x265/vpx/opus/webp are detected with ffmpeg configure\'s',
      '# require_pkg_config (a HARD pkg-config requirement) — e.g. x265 via',
      '# "require_pkg_config libx265 x265 x265.h x265_api_get". If a codec dep\'s',
      '# .pc dir is not already on PKG_CONFIG_PATH, configure aborts with',
      '# "ERROR: x265 not found using pkg-config". So also prepend every dep\'s',
      '# lib/pkgconfig (and share/pkgconfig) to PKG_CONFIG_PATH below.',
      'for _dep in \\',
      '  {{deps.lame.sourceforge.io.prefix}} \\',
      '  {{deps.libsdl.org.prefix}} \\',
      '  {{deps.freetype.org.prefix}} \\',
      '  {{deps.harfbuzz.org.prefix}} \\',
      '  {{deps.videolan.org/x264.prefix}} \\',
      '  {{deps.videolan.org/x265.prefix}} \\',
      '  {{deps.webmproject.org/libvpx.prefix}} \\',
      '  {{deps.opus-codec.org.prefix}} \\',
      '  {{deps.google.com/webp.prefix}}; do',
      '  if [ -d "$_dep/include" ]; then ARGS="$ARGS --extra-cflags=-I$_dep/include"; fi',
      '  if [ -d "$_dep/lib" ]; then ARGS="$ARGS --extra-ldflags=-L$_dep/lib"; fi',
      '  for _pc in "$_dep/lib/pkgconfig" "$_dep/share/pkgconfig"; do',
      '    if [ -d "$_pc" ]; then PKG_CONFIG_PATH="$_pc:${PKG_CONFIG_PATH:-}"; fi',
      '  done',
      'done',
      'export PKG_CONFIG_PATH',
      '',
      '# The publisher and the installer both rewrite Mach-O load commands',
      '# (install names, dependency references, rpaths). ffmpeg links its',
      '# libraries with only the linker\'s default slack, 56 bytes in',
      '# libavutil and libswresample, which a rewritten path does not fit in.',
      'if [ "$(uname)" = "Darwin" ]; then',
      '  ARGS="$ARGS --extra-ldflags=-Wl,-headerpad_max_install_names"',
      'fi',
      '',
      './configure $ARGS',
      'make --jobs {{hw.concurrency}}',
      'make install',
    ],
    env: {
      'ARGS': [
        '--prefix={{prefix}}',
        '--enable-libfreetype',
        '--enable-libmp3lame',
        '--enable-shared',
        '--enable-libx264',
        '--enable-gpl', // required for x264
        '--enable-libx265',
        '--enable-libvpx',
        '--enable-libopus',
        '--enable-libwebp',
      ],
      'CFLAGS': ['-Wno-incompatible-function-pointer-types'],
    },
  },

  // Run with the loader variables cleared, so the binaries have to find every
  // library through what the artifact itself carries.
  test: {
    required: true,
    script: [
      'run() { env -u LD_LIBRARY_PATH -u DYLD_LIBRARY_PATH -u DYLD_FALLBACK_LIBRARY_PATH "$@"; }',
      'run {{prefix}}/bin/ffmpeg -version',
      'run {{prefix}}/bin/ffprobe -version',
      'run {{prefix}}/bin/ffmpeg -nostdin -hide_banner -loglevel error -y -f lavfi -i testsrc=duration=1:size=160x120:rate=10 -f lavfi -i sine=frequency=440:duration=1 -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest -movflags +faststart h264.mp4',
      'test "$(run {{prefix}}/bin/ffprobe -v error -show_entries stream=codec_name -of csv=p=0 h264.mp4 | tr \'\\n\' \' \')" = "h264 aac "',
      'run {{prefix}}/bin/ffmpeg -nostdin -hide_banner -loglevel error -y -i h264.mp4 -c:v libvpx-vp9 -deadline realtime -cpu-used 8 -c:a libopus vp9.webm',
      'test "$(run {{prefix}}/bin/ffprobe -v error -show_entries stream=codec_name -of csv=p=0 vp9.webm | tr \'\\n\' \' \')" = "vp9 opus "',
      'run {{prefix}}/bin/ffmpeg -nostdin -hide_banner -loglevel error -y -i h264.mp4 -c:v libx265 -preset ultrafast -c:a libmp3lame hevc.mp4',
      'test "$(run {{prefix}}/bin/ffprobe -v error -show_entries stream=codec_name -of csv=p=0 hevc.mp4 | tr \'\\n\' \' \')" = "hevc mp3 "',
      'run {{prefix}}/bin/ffmpeg -nostdin -hide_banner -loglevel error -y -i h264.mp4 -frames:v 1 -c:v libwebp frame.webp',
      'run {{prefix}}/bin/ffmpeg -hide_banner -filters | grep " drawtext " >/dev/null',
    ],
  },
}
