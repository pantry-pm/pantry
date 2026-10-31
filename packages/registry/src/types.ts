import type { DisclosureMetadata, MalwareScanResult } from './malware-scanning'

/**
 * Package metadata stored in the registry
 */
export interface PackageMetadata {
  name: string
  version: string
  description?: string
  repository?: string
  homepage?: string
  license?: string
  author?: string
  keywords?: string[]
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  tarballUrl?: string
  checksum?: string
  publishedAt: string
  size?: number
  downloads?: number
  /** Publisher-declared dual-use policy, validated against packaged package.json. */
  contentPolicy?: unknown
  /** Digest/size only; disclosure text is never copied into registry metadata. */
  disclosure?: DisclosureMetadata
  /** Clean publish-time verdict for the exact uploaded bytes. */
  malwareScan?: MalwareScanResult
  /**
   * Set when the package is deprecated: the owner's message (npm's
   * `versions[v].deprecated`). Derived from the package's settings when the
   * document is served, never stored with the version.
   */
  deprecated?: string
}

/**
 * Package version entry
 */
export interface PackageVersion {
  version: string
  tarballUrl: string
  checksum: string
  publishedAt: string
  size: number
  contentPolicy?: unknown
  disclosure?: DisclosureMetadata
  malwareScan?: MalwareScanResult
}

/**
 * Full package record with all versions
 */
export type PackageVisibility = 'public' | 'unlisted' | 'private'

/** Per-package settings editable by the publisher on pantry.dev */
export interface PackagePublisherSettings {
  description?: string
  homepage?: string
  repository?: string
  license?: string
  keywords?: string[]
  /** Publish future releases to npmjs (when using pantry publish --npm) */
  npmPublish?: boolean
  /** npm package name if different from registry name */
  npmPackageName?: string
  npmAccess?: 'public' | 'restricted'
  /**
   * Who can see the package. `unlisted` keeps it out of search and listings;
   * `private` hides it from everyone but its owner, admins and the accounts
   * and package tokens the owner grants (see `private-packages.ts`).
   */
  visibility?: PackageVisibility
  /**
   * Retired by its owner (`pantry deprecate`, or the dashboard). Every version
   * stays installable; metadata carries `deprecated: "<message>"` and clients
   * warn. See `deprecation.ts`.
   */
  deprecated?: boolean
  deprecationMessage?: string
}

export interface PackageRecord {
  name: string
  description?: string
  repository?: string
  homepage?: string
  license?: string
  author?: string
  keywords?: string[]
  versions: Record<string, PackageVersion>
  latestVersion: string
  createdAt: string
  updatedAt: string
  totalDownloads: number
  /** Email of the account that owns this package (set on first publish) */
  publishedBy?: string
  settings?: PackagePublisherSettings
}

/** Summary row for the publisher dashboard */
export interface PublisherPackageSummary {
  name: string
  kind: 'registry' | 'commit'
  latestVersion?: string
  totalDownloads: number
  updatedAt: string
  commitCount: number
  description?: string
}

/**
 * Search result item
 */
export interface SearchResult {
  name: string
  version: string
  description?: string
  keywords?: string[]
  author?: string
  downloads: number
  /**
   * Set by storage when the package is private, so the registry can drop it
   * for callers who may not see it. Stripped before results leave the server.
   */
  private?: boolean
  /**
   * A private package for sale, listed as a storefront for a caller who hasn't
   * bought it: `version` is empty and `downloads` zero, and the price is here.
   */
  forSale?: boolean
  price?: number
  currency?: string
  formattedPrice?: string
  buyUrl?: string
}

/**
 * Publish request body
 */
export interface PublishRequest {
  metadata: PackageMetadata
  tarball: Blob | ArrayBuffer
}

/**
 * Registry configuration
 */
export interface RegistryConfig {
  /** Bucket name for tarball storage */
  s3Bucket: string
  /** Region / location slug for the storage provider */
  s3Region?: string
  /**
   * Object storage provider. AWS S3, Backblaze B2 and Hetzner Object Storage are
   * all S3-compatible. Defaults to `STORAGE_PROVIDER` env, then `'aws'`.
   */
  storageProvider?: 'aws' | 'backblaze' | 'hetzner' | 'r2'
  /** Endpoint host override (no scheme), e.g. `s3.us-west-004.backblazeb2.com`. */
  s3Endpoint?: string
  /** Force path-style addressing instead of virtual-hosted. */
  forcePathStyle?: boolean
  /** DynamoDB table name for metadata (only used when metadataBackend is 'dynamodb') */
  dynamoTable: string
  /**
   * Metadata storage backend. Defaults to 'object' for non-AWS providers (fully
   * off DynamoDB), 'dynamodb' when a table is configured on AWS, else 'file'.
   */
  metadataBackend?: 'dynamodb' | 'object' | 'file'
  /** Object key for the metadata snapshot when metadataBackend is 'object'. */
  metadataKey?: string
  /** Base URL for the registry (used in tarball URLs) */
  baseUrl: string
  /** Enable npmjs fallback for missing packages */
  npmFallback?: boolean
  /** Port to run the server on */
  port?: number
  /** Local filesystem path for development/test storage */
  localStoragePath?: string
}

/**
 * Commit publish record — represents a package published from a specific git commit
 * (equivalent to pkg-pr-new continuous releases)
 */
export interface CommitPublish {
  /** Package name (e.g., "@stacksjs/actions") */
  name: string
  /** Git commit SHA (short or full) */
  sha: string
  /** URL to download the tarball */
  tarballUrl: string
  /** SHA-256 checksum of the tarball */
  checksum: string
  /** ISO 8601 timestamp of when this was published */
  publishedAt: string
  /** Repository URL (e.g., "https://github.com/stacksjs/stacks") */
  repository?: string
  /** Relative path of the package within the repo */
  packageDir?: string
  /** Package version from package.json at time of commit */
  version?: string
  /** Tarball size in bytes */
  size?: number
  /** Account that published this commit snapshot */
  publishedBy?: string
  /** Clean publish-time verdict for the exact commit artifact. */
  malwareScan?: MalwareScanResult
}

/**
 * Summary of all packages published for a single commit
 */
export interface CommitPublishSummary {
  sha: string
  repository?: string
  publishedAt: string
  packages: CommitPublish[]
}

/**
 * A request for a version that doesn't exist in the registry
 */
export interface MissingVersionRequest {
  packageName: string
  version: string
  requestCount: number
  lastRequestedAt: string
  isKnownVersion?: boolean
}

/**
 * Paywall configuration for a package
 */
export interface PackagePaywall {
  /** Package name */
  name: string
  /** Whether the paywall is active */
  enabled: boolean
  /** Price in cents (e.g., 999 = $9.99) */
  price: number
  /** Currency code (default: "usd") */
  currency: string
  /** Stripe account ID of the package owner (for Stripe Connect payouts) */
  stripeAccountId?: string
  /** Stripe price ID (created when paywall is configured) */
  stripePriceId?: string
  /** Stripe product ID */
  stripeProductId?: string
  /** Optional: versions that are free (e.g., ["1.0.0", "2.0.0"]) */
  freeVersions?: string[]
  /** Optional: trial period in days */
  trialDays?: number
  /** When the paywall was created */
  createdAt: string
  /** When the paywall was last updated */
  updatedAt: string
}

/**
 * Access grant — records that an account (or, for grants written before
 * accounts, a token) may install a package. Written by a purchase, or by the
 * owner of a private package granting access.
 */
export interface PackageAccessGrant {
  /** Package name */
  packageName: string
  /** Grant subject: `user:<email>` for accounts, a raw token for legacy grants */
  token: string
  /** Stripe payment intent or subscription ID */
  stripePaymentId?: string
  /** When access was granted */
  grantedAt: string
  /** When access expires (undefined = lifetime) */
  expiresAt?: string
  /** Account that granted access by hand (absent for purchases) */
  grantedBy?: string
}

// ===========================================================================
// Authentication Types
// ===========================================================================

/**
 * Registered user account
 */
export type UserRole = 'admin' | 'user'

export interface User {
  /** User's email address (unique identifier) */
  email: string
  /** Display name */
  name: string
  /** Argon2id password hash (via Bun.password) */
  passwordHash: string
  /** Site-wide permissions (admin can manage all packages on pantry.dev) */
  role?: UserRole
  /**
   * Paid plan, when there is one. Governs the marketplace commission on this
   * account's sales and the features it can use — see `subscriptions.ts`.
   * Absent means Free; the tier is never inferred from anything else, so a
   * billing outage can't silently upgrade or downgrade anyone.
   */
  subscription?: UserSubscription
  /**
   * Accounts this one shares its packages with (Team plan). Present on the
   * seat holder — the account that pays and owns the packages.
   */
  team?: UserTeam
  /**
   * The seat holder this account belongs to, when it is a member of someone
   * else's team. An account is on at most one team, which keeps "who may
   * publish this" a single lookup rather than a graph walk.
   */
  teamOwner?: string
  /** ISO 8601 timestamp */
  createdAt: string
  /** ISO 8601 timestamp */
  updatedAt: string
}

/** The members sharing a seat holder's packages. */
export interface UserTeam {
  /** Member emails. The seat holder is not listed — they're the owner. */
  members: string[]
  updatedAt?: string
}

/** The stored half of a subscription. Interpretation lives in `subscriptions.ts`. */
export interface UserSubscription {
  /** 'pro' | 'team'. Free accounts have no record at all. */
  tier: string
  /** Stripe's subscription status, verbatim. */
  status: string
  stripeCustomerId?: string
  stripeSubscriptionId?: string
  /** End of the paid period — a cancelled plan keeps its benefits until then. */
  currentPeriodEnd?: string
  /** Given by the registry operator rather than bought; ends at currentPeriodEnd when set. */
  comped?: boolean
  updatedAt?: string
}

/**
 * API token for programmatic access (e.g., publishing)
 */
export interface ApiToken {
  /** Operator-issued exact native package domains. Ordinary account tokens cannot grant these. */
  binaryPublishDomains?: string[]
  /** Token ID (e.g., "ptry_abc123...") — only returned at creation time */
  id: string
  /** User-provided label (e.g., "CI deploy token") */
  name: string
  /** Owner's email */
  userId: string
  /** SHA-256 hash of the full token string — used for lookup */
  tokenHash: string
  /** Granted permissions */
  permissions: ('publish' | 'read')[]
  /** ISO 8601 timestamp */
  createdAt: string
  /** ISO 8601 timestamp of last use (updated on each validated request) */
  lastUsedAt?: string
  /** ISO 8601 expiry (undefined = never expires) */
  expiresAt?: string
  /**
   * Package names this token is confined to. A scoped token may read exactly
   * these packages and nothing else — no account, publish or admin rights.
   */
  packageScope?: string[]
  /** Account that minted a package-scoped token */
  createdBy?: string
}

/**
 * Subset of ApiToken returned in listings (never includes raw token or hash)
 */
export interface ApiTokenInfo {
  binaryPublishDomains?: string[]
  packageScope?: string[]
  id: string
  name: string
  permissions: ('publish' | 'read')[]
  createdAt: string
  lastUsedAt?: string
  expiresAt?: string
}

/**
 * Web session for authenticated site access
 */
export interface Session {
  /** SHA-256 hash of the session token — used as DynamoDB key */
  tokenHash: string
  /** Owner's email */
  userId: string
  /** ISO 8601 timestamp */
  createdAt: string
  /** ISO 8601 expiry */
  expiresAt: string
}

/**
 * Result of validating a Bearer token during publish
 */
export interface TokenValidationResult {
  binaryPublishDomains?: string[]
  /** Present when the token is confined to specific packages */
  packageScope?: string[]
  valid: boolean
  userId?: string
  tokenId?: string
  error?: string
}

/**
 * Storage interface for authentication data.
 * Uses the same DynamoDB table (single-table design) in production.
 */
export interface AuthStorage {
  // User operations
  getUser(email: string): Promise<User | null>
  putUser(user: User): Promise<void>
  /** Create or replace a user (no uniqueness condition — for admin provisioning) */
  upsertUser(user: User): Promise<void>
  getUserByEmail(email: string): Promise<User | null>

  // API token operations
  putApiToken(token: ApiToken): Promise<void>
  getApiTokenByHash(tokenHash: string): Promise<ApiToken | null>
  listApiTokens(userId: string): Promise<ApiToken[]>
  deleteApiToken(userId: string, tokenId: string): Promise<void>
  updateTokenLastUsed(tokenHash: string): Promise<void>

  // Session operations
  putSession(session: Session): Promise<void>
  getSession(tokenHash: string): Promise<Session | null>
  deleteSession(tokenHash: string): Promise<void>
}

// ===========================================================================
// Storage Interfaces
// ===========================================================================

/**
 * Storage interface for tarball storage
 */
export interface TarballStorage {
  upload(key: string, data: ArrayBuffer): Promise<string>
  download(key: string): Promise<ArrayBuffer>
  exists(key: string): Promise<boolean>
  delete(key: string): Promise<void>
  getUrl(key: string): string
  list(prefix: string): Promise<string[]>
}

/**
 * Metadata storage interface
 */
export interface MetadataStorage {
  /** Drain pending persistence before shutting down an owned store. */
  flush?: () => Promise<void>
  getPackage(name: string): Promise<PackageRecord | null>
  getPackageVersion(name: string, version: string): Promise<PackageMetadata | null>
  putPackage(record: PackageRecord): Promise<void>
  /**
   * `settingsIfNew` is applied only when this call creates the package, in the
   * same write, so a package published private is never briefly public.
   */
  putVersion(name: string, version: string, metadata: PackageMetadata, options?: { ifAbsent?: boolean, settingsIfNew?: PackagePublisherSettings }): Promise<void>
  search(query: string, limit?: number): Promise<SearchResult[]>
  listVersions(name: string): Promise<string[]>
  incrementDownloads(name: string, version: string): Promise<void>

  // Commit publish operations
  putCommitPublish(publish: CommitPublish): Promise<void>
  getCommitPublish(sha: string, name: string): Promise<CommitPublish | null>
  getCommitPackages(sha: string): Promise<CommitPublish[]>
  getPackageCommits(name: string, limit?: number): Promise<CommitPublish[]>

  // Publisher dashboard
  listPackagesByPublisher(userId: string, limit?: number): Promise<PublisherPackageSummary[]>
  listAllRegistryPackages(limit?: number): Promise<PublisherPackageSummary[]>
  updatePublisherPackage(
    name: string,
    userId: string,
    updates: Partial<PackageRecord> & { settings?: PackagePublisherSettings },
  ): Promise<PackageRecord>
  setPackagePublisher(name: string, userId: string): Promise<void>
  setCommitPublisher(name: string, sha: string, userId: string): Promise<void>

  // Paywall operations
  getPaywall(name: string): Promise<PackagePaywall | null>
  putPaywall(paywall: PackagePaywall): Promise<void>
  deletePaywall(name: string): Promise<void>
  getAccessGrant(packageName: string, token: string): Promise<PackageAccessGrant | null>
  putAccessGrant(grant: PackageAccessGrant): Promise<void>
  /** Every grant on a package, expired ones included (the owner should see those). */
  listAccessGrants(packageName: string): Promise<PackageAccessGrant[]>
  deleteAccessGrant(packageName: string, token: string): Promise<void>
}
