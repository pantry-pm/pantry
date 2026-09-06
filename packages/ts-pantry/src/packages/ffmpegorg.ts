/**
 * **ffmpeg** - Play, record, convert, and stream audio and video
 *
 * @domain `ffmpeg.org`
 * @programs `ffmpeg`, `ffplay`, `ffprobe`
 * @version `9.0.1` (89 versions available)
 * @versions From newest version to oldest.
 *
 * @install `pantry install ffmpeg.org`
 * @homepage https://ffmpeg.org/
 * @dependencies `lame.sourceforge.io>=3.98.3`, `libsdl.org^2`, `freetype.org^2`, ... (+6 more)
 *
 * @example
 * ```typescript
 * import { pantry } from 'ts-pantry'
 *
 * const pkg = pantry.ffmpegorg
 * console.log(pkg.name)        // "ffmpeg"
 * console.log(pkg.description) // "Play, record, convert, and stream audio and video"
 * console.log(pkg.programs)    // ["ffmpeg", "ffplay", ...]
 * console.log(pkg.versions[0]) // "9.0.1" (latest)
 * ```
 *
 * @see https://ts-pantry.netlify.app/packages/ffmpeg-org.md
 * @see https://ts-pantry.netlify.app/usage
 */
export const ffmpegorgPackage = {
  /**
  * The display name of this package.
  */
  name: 'ffmpeg' as const,
  /**
  * The canonical domain name for this package.
  */
  domain: 'ffmpeg.org' as const,
  /**
  * Brief description of what this package does.
  */
  description: 'Play, record, convert, and stream audio and video' as const,
  packageYmlUrl: 'https://github.com/pkgxdev/pantry/tree/main/projects/ffmpeg.org/package.yml' as const,
  homepageUrl: 'https://ffmpeg.org/' as const,
  githubUrl: 'https://github.com/FFmpeg/FFmpeg' as const,
  /**
  * Command to install this package using pantry.
  * @example pantry install package-name
  */
  installCommand: 'pantry install ffmpeg.org' as const,
  pantryInstallCommand: 'pantry install ffmpeg.org' as const,
  /**
  * Executable programs provided by this package.
  * These can be run after installation.
  */
  programs: [
    'ffmpeg',
    'ffplay',
    'ffprobe',
  ] as const,
  companions: [] as const,
  /**
  * Runtime dependencies for this package.
  * These are required when running the package.
  */
  dependencies: [
    'lame.sourceforge.io>=3.98.3',
    'libsdl.org^2',
    'freetype.org^2',
    'harfbuzz.org^8',
    'videolan.org/x264^0.164',
    'videolan.org/x265^3',
    'webmproject.org/libvpx~1.14 # libvpx abi changes in 1.15',
    'opus-codec.org^1',
    'google.com/webp^1',
  ] as const,
  buildDependencies: [] as const,
  /**
  * Available versions from newest to oldest.
  * @see https://ts-pantry.netlify.app/usage for installation instructions
  */
  versions: [
    '9.0.1',
    '9.0',
    '8.1.2',
    '8.1.1',
    '8.1',
    '8.1.0',
    '8.0.3',
    '8.0.2',
    '8.0.1',
    '8.0',
    '8.0.0',
    '7.1.5',
    '7.1.4',
    '7.1.3',
    '7.1.2',
    '7.1.1',
    '7.1',
    '7.1.0',
    '7.0.3',
    '7.0.2',
    '7.0.1',
    '7.0',
    '7.0.0',
    '6.1.6',
    '6.1.5',
    '6.1.4',
    '6.1.3',
    '6.1.2',
    '6.1.1',
    '6.1',
    '6.1.0',
    '6.0.1',
    '6.0',
    '6.0.0',
    '5.1.10',
    '5.1.9',
    '5.1.8',
    '5.1.7',
    '5.1.6',
    '5.1.5',
    '5.1.4',
    '5.1.3',
    '5.1.2',
    '5.1.1',
    '5.1',
    '5.0.3',
    '5.0.2',
    '5.0.1',
    '5.0',
    '4.4.8',
    '4.4.7',
    '4.4.6',
    '4.4.5',
    '4.4.4',
    '4.4.3',
    '4.4.2',
    '4.4.1',
    '4.4',
    '4.3.9',
    '4.3.8',
    '4.3.7',
    '4.3.6',
    '4.3.5',
    '4.3.4',
    '4.3.3',
    '4.3.2',
    '4.3.1',
    '4.3',
    '4.2.11',
    '4.2.10',
    '4.2.9',
    '4.2.8',
    '4.2.7',
    '4.2.6',
    '4.2.5',
    '4.2.4',
    '4.2.3',
    '4.2.2',
    '4.2.1',
    '4.2',
    '4.1.11',
    '4.1.10',
    '4.1.9',
    '4.1.8',
    '4.1.7',
    '4.1.6',
    '4.1.5',
    '3.4.14',
    '3.4.13',
  ] as const,
  aliases: [] as const,
}

export type FfmpegorgPackage = typeof ffmpegorgPackage
