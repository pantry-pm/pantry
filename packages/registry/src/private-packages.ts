/**
 * Private packages — published to the registry, visible to almost nobody.
 *
 * A package is private when it is first published with npm's
 * `"publishConfig": { "access": "restricted" }`, or when its owner switches it
 * in the package settings. After that, every read surface (metadata, version
 * lists, tarballs, search, listings, badges, analytics, the web pages) answers
 * exactly as it would for a package that does not exist — unless the caller is
 * one of:
 *
 *   - an admin (the shared registry token, or an admin session),
 *   - the owner, or a member of the owner's team,
 *   - an account holding an unexpired access grant, directly or through the
 *     team it belongs to — the same `user:<email>` grants a purchase writes,
 *   - a package-scoped read token for that package (what a client's CI holds).
 *
 * The owner manages who that is:
 *
 *   GET    /packages/{name}/access          — grants and package tokens
 *   PUT    /packages/{name}/access          {email, expiresAt?} — grant
 *   DELETE /packages/{name}/access          {email}             — revoke
 *   POST   /packages/{name}/tokens          {name, expiresInDays?} — mint
 *   GET    /packages/{name}/tokens          — list (no secrets)
 *   DELETE /packages/{name}/tokens/{id}     — revoke
 *
 * Grants reuse the paywall's storage rather than a parallel table, so a buyer
 * of a paid package and a client granted a private one are the same kind of
 * record, and `isEntitled` answers for both.
 */

import { isEntitled, accountSubject } from './paywall'
import type { MetadataStorage, PackageAccessGrant, PackageRecord } from './types'
import { readPackagedManifests } from './malware-scanning'

/** Whether a stored package is private. */
export function isPrivatePackage(record: Pick<PackageRecord, 'settings'> | null | undefined): boolean {
  return record?.settings?.visibility === 'private'
}

function wantsRestricted(manifest: unknown): boolean {
  if (!manifest || typeof manifest !== 'object') return false
  const publishConfig = (manifest as Record<string, unknown>).publishConfig
  if (!publishConfig || typeof publishConfig !== 'object') return false
  const access = (publishConfig as Record<string, unknown>).access
  return typeof access === 'string' && access.trim().toLowerCase() === 'restricted'
}

/**
 * Did this upload ask to be private?
 *
 * The request metadata is what the CLI sends; the manifest inside the tarball
 * is what the author wrote. Either one saying `restricted` is enough — when the
 * two disagree, the private reading is the one that can't leak anything.
 */
export function restrictedAccessRequested(metadata: unknown, tarball?: ArrayBuffer): boolean {
  if (wantsRestricted(metadata)) return true
  if (!tarball) return false
  return readPackagedManifests(tarball).some(wantsRestricted)
}

/** Who is reading, as far as private-package checks are concerned. */
export interface PackageReader {
  /** Registry token or an admin session. */
  admin: boolean
  /** Account email, when signed in with a session or an account token. */
  email?: string | null
  /** The seat holder whose team this account is on (or the account itself). */
  org?: string | null
  /** Whether the bearer token is a read token scoped to this package. */
  scopedTo?: (packageName: string) => Promise<boolean>
  /** Whether `email` may act for `owner` (same account, or on their team). */
  canActFor?: (email: string, owner: string) => Promise<boolean>
}

/**
 * Decide whether a reader may see a package. Public and unlisted packages are
 * readable by anyone; this only ever says no to a private one.
 */
export async function canReadPackage(
  storage: MetadataStorage,
  record: Pick<PackageRecord, 'name' | 'settings' | 'publishedBy'> | null | undefined,
  reader: PackageReader,
): Promise<boolean> {
  if (!record || !isPrivatePackage(record)) return true
  if (reader.admin) return true

  const email = reader.email?.toLowerCase().trim() || null
  const org = reader.org?.toLowerCase().trim() || null
  const owner = record.publishedBy?.toLowerCase().trim() || null

  if (email && owner) {
    if (email === owner || org === owner) return true
    if (reader.canActFor && await reader.canActFor(email, owner)) return true
  }

  // A grant to the account, or to the team it's on. Expired grants don't count.
  if (email && await isEntitled(storage, record.name, email, org)) return true

  return reader.scopedTo ? reader.scopedTo(record.name) : false
}

// ---------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** A grant as the access API shows it. */
export interface AccessGrantView {
  subject: string
  email?: string
  name?: string
  expiresAt?: string | null
  createdAt: string
}

/** Normalize a grantee email, or null when it isn't one. */
export function normalizeGrantEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const email = value.toLowerCase().trim()
  return EMAIL_PATTERN.test(email) && email.length <= 254 ? email : null
}

/**
 * Parse a requested expiry. `undefined`/`null` mean "never"; anything else must
 * be a date in the future. Returns the ISO string, null for never, or an error.
 */
export function parseGrantExpiry(value: unknown): { expiresAt: string | null } | { error: string } {
  if (value === undefined || value === null || value === '') return { expiresAt: null }
  if (typeof value !== 'string') return { error: 'expiresAt must be an ISO 8601 date or null' }
  const time = Date.parse(value)
  if (!Number.isFinite(time)) return { error: 'expiresAt must be an ISO 8601 date or null' }
  if (time <= Date.now()) return { error: 'expiresAt must be in the future' }
  return { expiresAt: new Date(time).toISOString() }
}

function grantEmail(grant: PackageAccessGrant): string | null {
  return grant.token.startsWith('user:') ? grant.token.slice('user:'.length) : null
}

/** Shape a stored grant for the API. Legacy raw-token grants are never shown. */
export function viewGrant(grant: PackageAccessGrant, name?: string): AccessGrantView | null {
  const email = grantEmail(grant)
  if (!email) return null
  return {
    subject: grant.token,
    email,
    ...(name ? { name } : {}),
    expiresAt: grant.expiresAt || null,
    createdAt: grant.grantedAt,
  }
}

/** The account grants on a package. Purchases included; legacy token grants not. */
export async function listAccountGrants(storage: MetadataStorage, packageName: string): Promise<PackageAccessGrant[]> {
  const grants = await storage.listAccessGrants(packageName)
  return grants
    .filter(grant => grantEmail(grant) !== null)
    .sort((a, b) => a.grantedAt.localeCompare(b.grantedAt))
}

/**
 * Grant an account access, or change the expiry of an existing grant. The
 * original grant date and any purchase reference are kept.
 */
export async function grantPackageAccess(
  storage: MetadataStorage,
  packageName: string,
  email: string,
  options: { expiresAt: string | null, grantedBy: string },
): Promise<PackageAccessGrant> {
  const subject = accountSubject(email)
  const existing = (await storage.listAccessGrants(packageName)).find(grant => grant.token === subject)
  const grant: PackageAccessGrant = {
    packageName,
    token: subject,
    grantedAt: existing?.grantedAt || new Date().toISOString(),
    ...(existing?.stripePaymentId ? { stripePaymentId: existing.stripePaymentId } : {}),
    ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}),
    grantedBy: options.grantedBy,
  }
  await storage.putAccessGrant(grant)
  return grant
}

/** Revoke an account's grant. False when there was none. */
export async function revokePackageAccess(storage: MetadataStorage, packageName: string, email: string): Promise<boolean> {
  const subject = accountSubject(email)
  const existing = (await storage.listAccessGrants(packageName)).some(grant => grant.token === subject)
  if (!existing) return false
  await storage.deleteAccessGrant(packageName, subject)
  return true
}
