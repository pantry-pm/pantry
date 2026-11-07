export const bitwardencomdesktopPackage = {
  name: 'Bitwarden' as const, domain: 'bitwarden.com/desktop' as const,
  description: 'The Bitwarden desktop password manager.' as const,
  packageYmlUrl: '' as const, homepageUrl: 'https://bitwarden.com' as const,
  githubUrl: 'https://github.com/bitwarden/clients' as const,
  installCommand: 'pantry install bitwarden-desktop' as const,
  programs: [] as const, companions: [] as const, dependencies: [] as const, buildDependencies: [] as const,
  versions: ['2026.10.4'] as const, aliases: ['bitwarden-desktop', 'bitwarden-app'] as const,
}
export type BitwardencomdesktopPackage = typeof bitwardencomdesktopPackage
