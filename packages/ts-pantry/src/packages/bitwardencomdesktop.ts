export const bitwardencomdesktopPackage = {
  name: 'Bitwarden' as const, domain: 'bitwarden.com/desktop' as const,
  description: 'The Bitwarden desktop password manager.' as const,
  packageYmlUrl: '' as const, homepageUrl: 'https://bitwarden.com' as const,
  githubUrl: 'https://github.com/bitwarden/clients' as const,
  installCommand: 'pantry install bitwarden-desktop' as const,
  programs: [] as const, companions: [] as const, dependencies: [] as const, buildDependencies: [] as const,
  versions: [
    '2026.10.4',
    '2026.10.3',
    '2026.10.2',
    '2026.10.1',
    '2026.10.0',
    '2026.9.1',
    '2026.9.0',
    '2026.8.0',
    '2026.7.0',
    '2026.6.1',
    '2026.6.0',
    '2026.5.0',
  ] as const, aliases: ['bitwarden-desktop', 'bitwarden-app'] as const,
}
export type BitwardencomdesktopPackage = typeof bitwardencomdesktopPackage
