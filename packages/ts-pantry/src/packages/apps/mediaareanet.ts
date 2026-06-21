/**
 * **MediaInfo** - Display technical and tag data for video and audio files.
 *
 * @domain `mediaarea.net`
 * @version `26.05`
 *
 * @install `pantry install mediaarea.net`
 * @homepage https://mediaarea.net/en/MediaInfo
 */
export const mediaareanetPackage = {
  name: 'MediaInfo' as const,
  domain: 'mediaarea.net' as const,
  description: 'Display technical and tag data for video and audio files.' as const,
  packageYmlUrl: '' as const,
  homepageUrl: 'https://mediaarea.net/en/MediaInfo' as const,
  githubUrl: 'https://github.com/MediaArea/MediaInfo' as const,
  installCommand: 'pantry install mediaarea.net' as const,
  programs: [] as const,
  companions: [] as const,
  dependencies: [] as const,
  buildDependencies: [] as const,
  versions: ['26.05'] as const,
  aliases: [] as const,
}
export type MediaareanetPackage = typeof mediaareanetPackage
