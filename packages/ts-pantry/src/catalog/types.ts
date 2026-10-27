export type PackageKind = 'app' | 'cli' | 'library' | 'font'

/** Artwork is upstream artwork, retained unchanged with its source recorded. */
export interface PackageLogo {
  url: string
  sourceUrl: string
  sha256: string
}

/** Public discovery metadata, independent of any installer or application host. */
export interface PackageCatalogEntry {
  domain: string
  name: string
  description: string
  kind: PackageKind
  aliases: string[]
  programs: string[]
  latestVersion: string | null
  homepageUrl: string | null
  githubUrl: string | null
  /** Null means the recipe does not declare a platform restriction. Actual artifact availability is checked before installation. */
  platforms: string[] | null
  logo: PackageLogo | null
}
