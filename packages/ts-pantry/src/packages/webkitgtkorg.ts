/**
 * **webkitgtk** - WebKit rendering engine for GTK, providing the webkit2gtk-4.1 API
 *
 * @domain `webkitgtk.org`
 * @version `2.54.2` (3 versions available)
 * @versions From newest version to oldest.
 *
 * @install `pantry install webkitgtk.org`
 * @homepage https://webkitgtk.org
 * @dependencies `gtk.org/gtk3^3.24`, `gnome.org/glib^2`, `libsoup.org^3`, ... (+26 more)
 * @buildDependencies `cmake.org^3`, `ninja-build.org`, `freedesktop.org/pkg-config`, ... (+4 more) - required only when building from source
 *
 * @example
 * ```typescript
 * import { pantry } from 'ts-pantry'
 *
 * const pkg = pantry.webkitgtkorg
 * console.log(pkg.name)        // "webkitgtk"
 * console.log(pkg.description) // "WebKit rendering engine for GTK, providing the ..."
 * console.log(pkg.versions[0]) // "2.54.2" (latest)
 * ```
 *
 * @see https://ts-pantry.netlify.app/packages/webkitgtk-org.md
 * @see https://ts-pantry.netlify.app/usage
 */
export const webkitgtkorgPackage = {
  /**
  * The display name of this package.
  */
  name: 'webkitgtk' as const,
  /**
  * The canonical domain name for this package.
  */
  domain: 'webkitgtk.org' as const,
  /**
  * Brief description of what this package does.
  */
  description: 'WebKit rendering engine for GTK, providing the webkit2gtk-4.1 API' as const,
  packageYmlUrl: '' as const,
  homepageUrl: 'https://webkitgtk.org' as const,
  githubUrl: 'https://github.com/WebKit/WebKit' as const,
  /**
  * Command to install this package using pantry.
  * @example pantry install package-name
  */
  installCommand: 'pantry install webkitgtk.org' as const,
  pantryInstallCommand: 'pantry install webkitgtk.org' as const,
  programs: [] as const,
  companions: [] as const,
  /**
  * Runtime dependencies for this package.
  * These are required when running the package.
  */
  dependencies: [
    'gtk.org/gtk3^3.24',
    'gnome.org/glib^2',
    'libsoup.org^3',
    'unicode.org',
    'cairographics.org',
    'gnome.org/pango',
    'harfbuzz.org',
    'freetype.org',
    'freedesktop.org/fontconfig',
    'gnome.org/libxml2',
    'gnome.org/libxslt',
    'sqlite.org',
    'libjpeg-turbo.org',
    'libpng.org',
    'google.com/webp',
    'google.com/woff2',
    'gnu.org/libtasn1',
    'gnupg.org/libgcrypt',
    'littlecms.com',
    'gnome.org/atk',
    'gnome.org/gdk-pixbuf',
    'github.com/anholt/libepoxy',
    'gnome.org/libsecret',
    'openjpeg.org',
    'zlib.net',
    'x.org/x11',
    'x.org/exts',
    'wayland.freedesktop.org',
    'mesa3d.org',
  ] as const,
  /**
  * Available versions from newest to oldest.
  * @see https://ts-pantry.netlify.app/usage for installation instructions
  */
  versions: [
    '2.54.2',
    '2.54.1',
    '2.54.0',
  ] as const,
  /**
  * Build dependencies for this package.
  * These are only required when building the package from source.
  */
  buildDependencies: [
    'cmake.org^3',
    'ninja-build.org',
    'freedesktop.org/pkg-config',
    'gnu.org/gettext',
    'gnu.org/gperf',
    'ruby-lang.org',
    'python.org^3',
  ] as const,
  aliases: [] as const,
}

export type WebkitgtkorgPackage = typeof webkitgtkorgPackage
