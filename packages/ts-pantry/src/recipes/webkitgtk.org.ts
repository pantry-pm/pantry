import type { Recipe } from '../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'webkitgtk.org',
  name: 'webkitgtk',
  description: 'WebKit rendering engine for GTK, providing the webkit2gtk-4.1 API',
  homepage: 'https://webkitgtk.org',
  github: 'https://github.com/WebKit/WebKit',
  programs: [],

  // WebKitGTK 2.x builds exactly one API per configure, chosen by USE_GTK4:
  // ON (upstream's default) gives GTK4 + webkitgtk-6.0, OFF gives GTK3 +
  // webkit2gtk-4.1. Source/cmake/OptionsGTK.cmake sets WEBKITGTK_API_INFIX to
  // "2" for 4.1, which is why the sonames are libwebkit2gtk-4.1.so.0 and
  // libjavascriptcoregtk-4.1.so.0 — the two craft-native.org's Linux binary
  // fails to resolve. 4.1 is GTK3 + libsoup3; upstream deprecated libsoup2
  // (API 4.0), and 2.54's OptionsGTK.cmake now calls find_package(Soup3 3.0.0
  // REQUIRED) unconditionally, so there is no soup2 variant left to pick.
  // WPE and the GTK4 6.0 API are DIFFERENT APIs, not substitutes: neither
  // provides these sonames.
  platforms: ['linux/x86-64'],

  versionSource: {
    type: 'github-tags',
    repo: 'WebKit/WebKit',
    // The WebKit monorepo tags every port; only webkitgtk-* releases are ours.
    // Anchored, with a bounded numeric capture, so a hypothetical
    // webkitgtk-2.54.0-rc1 cannot match (github-tags carries no prerelease
    // flag) and the pattern cannot backtrack super-linearly.
    tagPattern: /^webkitgtk-(\d+(?:\.\d+){0,3})$/,
  },

  distributable: {
    // Upstream's own release tarballs, not the monorepo archive: the GitHub
    // tag tree is the whole of WebKit (every port) and does not carry the
    // generated files the release tarball ships.
    url: 'https://webkitgtk.org/releases/webkitgtk-{{version}}.tar.xz',
    stripComponents: 1,
  },

  // libwebkit2gtk does not do its own rendering in-process: it spawns
  // WebKitWebProcess and WebKitNetworkProcess from PKGLIBEXECDIR and loads the
  // injected bundle from the lib tree (Source/WebKit/PlatformGTK.cmake installs
  // it under lib/webkit2gtk-4.1/injected-bundle). A consumer that bundles only
  // the .so gets a library that loads and then fails the moment a page is
  // created, so both directories travel with it.
  runtimeResources: [
    'libexec/webkit2gtk-4.1',
    'lib/webkit2gtk-4.1/injected-bundle',
  ],

  // Every domain below is published for linux-x86-64 today; this closure was
  // checked against the registry before the recipe was written, because a
  // dependency declaration naming a provider that does not exist fails at
  // install time rather than at publish time.
  dependencies: {
    'gtk.org/gtk3': '^3.24',
    'gnome.org/glib': '^2',
    'libsoup.org': '^3',
    'unicode.org': '*',
    'cairographics.org': '*',
    'gnome.org/pango': '*',
    'harfbuzz.org': '*',
    'freetype.org': '*',
    'freedesktop.org/fontconfig': '*',
    'gnome.org/libxml2': '*',
    'gnome.org/libxslt': '*',
    'sqlite.org': '*',
    'libjpeg-turbo.org': '*',
    'libpng.org': '*',
    'google.com/webp': '*',
    'google.com/woff2': '*',
    'gnu.org/libtasn1': '*',
    'gnupg.org/libgcrypt': '*',
    'littlecms.com': '*',
    'gnome.org/atk': '*',
    'gnome.org/gdk-pixbuf': '*',
    'github.com/anholt/libepoxy': '*',
    'gnome.org/libsecret': '*',
    'openjpeg.org': '*',
    'zlib.net': '*',
    'x.org/x11': '*',
    'x.org/exts': '*',
    'wayland.freedesktop.org': '*',
    'mesa3d.org': '*',
  },

  buildDependencies: {
    'cmake.org': '^3',
    'ninja-build.org': '*',
    'freedesktop.org/pkg-config': '*',
    'gnu.org/gettext': '*',
    'gnu.org/gperf': '*',
    'ruby-lang.org': '*',
    'python.org': '^3',
  },

  build: {
    script: [
      'cmake -S . -B build -G Ninja $CMAKE_ARGS',
      'cmake --build build',
      'cmake --install build',
    ],
    env: {
      CMAKE_ARGS: [
        '-DPORT=GTK',
        '-DCMAKE_BUILD_TYPE=Release',
        '-DCMAKE_INSTALL_PREFIX={{prefix}}',
        '-DCMAKE_INSTALL_LIBDIR=lib',
        '-DCMAKE_INSTALL_LIBEXECDIR=libexec',
        '-DCMAKE_INSTALL_RPATH={{prefix}}/lib',
        '-DCMAKE_FIND_FRAMEWORK=LAST',
        '-Wno-dev',

        // The API selector. Everything else here exists to keep that build's
        // dependency closure inside what Pantry actually publishes.
        '-DUSE_GTK4=OFF',

        // GStreamer is NOT optional behind ENABLE_VIDEO. GStreamerChecks.cmake
        // guards on USE_GSTREAMER and then calls find_package(GStreamer 1.18.4
        // REQUIRED COMPONENTS app pbutils) with app/pbutils listed
        // unconditionally — turning off video and web audio alone still fails
        // configure. Pantry's catalog has gstreamer.freedesktop.org/orc and no
        // GStreamer core or gst-plugins-base, and neither does pkgx, so the
        // whole subsystem is off until those recipes exist. Consequence, stated
        // plainly: <video>, <audio> and WebAudio do not work in this build.
        '-DUSE_GSTREAMER=OFF',
        '-DENABLE_VIDEO=OFF',
        '-DENABLE_WEB_AUDIO=OFF',
        '-DENABLE_MEDIA_SOURCE=OFF',
        '-DENABLE_MEDIA_STREAM=OFF',
        '-DENABLE_MEDIA_RECORDER=OFF',
        '-DENABLE_MEDIA_SESSION=OFF',
        '-DUSE_GSTREAMER_WEBRTC=OFF',
        // ENABLE_WEB_RTC already defaults OFF for this port; pinning it keeps
        // the ENABLE_MEDIA_STREAM AND ENABLE_WEB_RTC branch in
        // GStreamerChecks.cmake — which sits OUTSIDE the USE_GSTREAMER guard
        // and would otherwise turn on the bundled libwebrtc — unreachable.
        '-DENABLE_WEB_RTC=OFF',

        // Each of these has a find_package ... FATAL_ERROR in OptionsGTK.cmake
        // and no provider in the catalog: Enchant (spellcheck), libhyphen
        // (automatic hyphenation), libmanette (gamepad), libdrm/GBM — and
        // ENABLE_GPU_PROCESS depends on USE_GBM, so it goes with them.
        '-DENABLE_SPELLCHECK=OFF',
        '-DUSE_LIBHYPHEN=OFF',
        '-DENABLE_GAMEPAD=OFF',
        '-DUSE_LIBDRM=OFF',
        '-DUSE_GBM=OFF',
        '-DENABLE_GPU_PROCESS=OFF',
        '-DENABLE_SPEECH_SYNTHESIS=OFF',
        '-DENABLE_JOURNALD_LOG=OFF',
        '-DUSE_LIBBACKTRACE=OFF',
        '-DUSE_JPEGXL=OFF',
        '-DUSE_AVIF=OFF',

        // The sandbox needs bubblewrap and xdg-dbus-proxy at RUNTIME, found by
        // absolute path; neither is a Pantry package, and a sandbox that cannot
        // find its helper refuses to start the web process.
        '-DENABLE_BUBBLEWRAP_SANDBOX=OFF',

        // Introspection pulls gi-docgen for documentation; craft links the C
        // ABI directly and needs no GIR, so both stay off to keep the build
        // closure to libraries we publish.
        '-DENABLE_INTROSPECTION=OFF',
        '-DENABLE_DOCUMENTATION=OFF',

        // MiniBrowser is a developer tool; this package ships libraries only
        // (programs: []), so building it would be dead weight in the artifact.
        '-DENABLE_MINIBROWSER=OFF',
      ],
    },
  },
}
