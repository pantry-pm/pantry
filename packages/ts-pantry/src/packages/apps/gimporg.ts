/**
 * **GIMP** - A free and open-source raster graphics editor.
 *
 * @domain `gimp.org`
 * @programs `gimp`
 * @version `3.2.8` (14 versions available)
 * @versions From newest version to oldest.
 *
 * @install `pantry install gimp.org`
 * @homepage https://gimp.org
 */
export const gimporgPackage = {
  name: 'GIMP' as const,
  domain: 'gimp.org' as const,
  description: 'A free and open-source raster graphics editor.' as const,
  packageYmlUrl: '' as const,
  homepageUrl: 'https://gimp.org' as const,
  githubUrl: '' as const,
  installCommand: 'pantry install gimp.org' as const,
  programs: ['gimp'] as const,
  companions: [] as const,
  dependencies: [] as const,
  buildDependencies: [] as const,
  versions: [
    '3.2.8',
    '3.2.6',
    '3.2.4',
    '3.2.2',
    '3.2.0',
    '3.0.8',
    '3.0.6',
    '3.0.4',
    '3.0.2',
    '3.0.0',
    '2.10.38',
    '2.10.36',
    '2.10.34',
    '2.10.32',
  ] as const,
  aliases: ['gimp'] as const,
}
export type GimporgPackage = typeof gimporgPackage
