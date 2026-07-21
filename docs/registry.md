# Pantry registry contract

This is the authoritative technical and operational reference for the registry
implemented in `packages/registry`. Route handlers remain the executable source
of truth. `bun run docs:contracts:check` verifies that critical routes, methods,
authentication boundaries, limits, storage semantics, and test links remain
represented here.

## Responsibilities and trust boundaries

The registry provides five distribution surfaces:

1. Pantry/npm-compatible package metadata and tarballs.
2. Commit-addressed preview packages used by `pantry publish:commit`.
3. Content-addressed Zig packages.
4. PHP/Composer packages.
5. Native binary, desktop application, and font metadata/tarball proxying.

It also serves search, analytics, publisher accounts/tokens, build status, and
the Pantry website. These surfaces share a process but not identical auth or
integrity semantics; clients must use the contract for the selected surface.

## Core package API

| Method | Path | Authentication | Behavior |
| --- | --- | --- | --- |
| `GET` | `/health` | Public | Process health and current timestamp. It does not prove every storage dependency is writable. |
| `GET` | `/search?q={query}&limit={n}&format=json` | Public | Search local metadata and optionally supplement from npm; query and result limits are bounded. |
| `GET` | `/packages/{name}` | Public | Return the latest stored version, with npm fallback when enabled. |
| `GET` | `/packages/{name}/{version}` | Public | Return an exact version; no version mutation occurs. |
| `GET` | `/packages/{name}/versions` | Public | List stored versions, falling back to npm only when configured. |
| `GET` | `/packages/{name}/{version}/tarball` | Public | Proxy exact bytes, update download analytics, and return 404 when unavailable. |
| `POST` | `/publish` | Legacy admin token or `ptry_` API token with publish permission | Accept multipart metadata/tarball or JSON/base64, validate limits, reject duplicates, persist bytes then metadata. |

Publishing validates package name, version, metadata size, content type, and a
50 MiB tarball limit. A duplicate `{name, version}` returns `409` before the
tarball is buffered where possible. Successful publication returns `201`; it
does not overwrite an existing immutable version.

The registry computes SHA-256 over uploaded bytes and records it as
`sha256:{hex}` alongside the canonical public proxy URL. This is integrity
evidence for the bytes received. It does not authenticate the publisher;
publisher identity comes from the accepted credential.

## Commit package API

| Method | Path | Authentication | Behavior |
| --- | --- | --- | --- |
| `POST` | `/publish/commit` | Legacy admin or `ptry_` publish token | Publish tarballs associated with a full commit SHA and optional repository/package directory. |
| `GET` | `/commits/{sha}` | Public | List packages stored for a commit. |
| `GET` | `/commits/{sha}/{name}` | Public | Return commit-package metadata. Scoped names are supported. |
| `GET` | `/commits/{sha}/{name}/tarball` | Public | Download exact commit-package bytes. |
| `GET` | `/{name}@{sha}` | Public | Short preview URL; resolves exact and supported alias forms. |

Each commit tarball is limited to 50 MiB. Production object storage applies the
documented expiry policy to the `commits/` prefix. Commit packages are previews,
not permanent semantic-version releases. Consumers should retain the commit SHA,
source repository, checksum, and test evidence.

## Zig API

| Method | Path | Authentication | Behavior |
| --- | --- | --- | --- |
| `GET` | `/zig/search?q={query}&limit={n}` | Public | Search Zig metadata; query length and limit are bounded. |
| `GET` | `/zig/packages/{name}` | Public | Latest Zig version and generated `zig fetch` and dependency snippets. |
| `GET` | `/zig/packages/{name}/{version}` | Public | Exact Zig metadata. |
| `GET` | `/zig/packages/{name}/versions` | Public | Version list sorted by registry storage. |
| `GET` | `/zig/packages/{name}/{version}/tarball` | Public | Download exact bytes and record analytics. |
| `GET` | `/zig/hash/{hash}` | Public | Resolve a Zig SHA-256 multihash to metadata. |
| `POST` | `/zig/publish` | Current `PANTRY_REGISTRY_TOKEN` or `PANTRY_TOKEN` | Publish multipart tarball plus optional `build.zig.zon`; reject duplicate version. |
| `DELETE` | `/zig/packages/{name}` | Current registry token | Delete all versions of the named Zig package. |

Zig publication computes the `1220` SHA-256 multihash over received bytes.
Manifest names using underscores are canonicalized to hyphens. The auth token is
read per request so a rotated token takes effect without re-importing the route
module; comparison is timing-safe and missing server configuration fails closed.

## PHP/Composer API

| Method | Path | Authentication | Behavior |
| --- | --- | --- | --- |
| `GET` | `/php/search?q={query}&limit={n}` | Public | Search Composer package metadata. |
| `GET` | `/php/packages/{vendor}/{package}` | Public | Latest metadata plus a generated Composer require command. |
| `GET` | `/php/packages/{vendor}/{package}/{version}` | Public | Exact version metadata. |
| `GET` | `/php/packages/{vendor}/{package}/versions` | Public | List versions. |
| `GET` | `/php/packages/{vendor}/{package}/{version}/tarball` | Public | Download exact bytes and record analytics. |
| `POST` | `/php/publish` | Current registry token | Publish multipart tarball and `composer.json`; reject duplicate version. |
| `DELETE` | `/php/packages/{vendor}/{package}` | Current registry token | Delete the complete package. |

PHP token lookup is per request and fails closed when the server token is
missing. The registry checksum is SHA-256 over the uploaded archive.

## Bulk resolver and native binary surfaces

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/npm/resolve` | Resolve multiple npm dependency specs for Pantry's install pipeline. |
| `GET` | `/npm/resolve/{specs}` | GET compatibility form for bounded spec lists. |
| `POST` | `/registry/download` | Stream or bundle resolved tarballs for efficient installs. |
| `POST` | `/npm/download` | Compatibility alias for registry download. |
| `GET` | `/binaries/{domain}/metadata.json` | Return package version/platform metadata. |
| `GET` | `/binaries/{domain}/{version}/{platform}/{artifact}` | Proxy an exact binary or checksum from object storage. |
| `GET` | `/desktop-apps` | List the configured desktop catalog with live version/platform availability. |
| `GET` | `/fonts` | List the configured font catalog with live availability. |

Binary paths are allowlisted and normalized before proxying. Public URLs may use
the registry proxy while storage remains private. A binary checksum is evidence
only when the client verifies it; availability metadata alone is not verification.

## Authentication and authorization

The registry supports:

- a legacy operator token from `PANTRY_REGISTRY_TOKEN` or `PANTRY_TOKEN`;
- account API tokens prefixed `ptry_`, stored only as hashes and scoped with
  `publish` and/or `read` permissions;
- HTTP-only web sessions for publisher/dashboard operations;
- npm trusted-publisher/OIDC flows in the Pantry CLI for compatible targets.

Core and commit publication accept the legacy token or a valid user publish
token. Build-event, build-log, and rebuild mutations accept an authorized bearer
token or signed-in session. Zig and PHP mutation routes currently accept the
operator token, not user API tokens. This is current behavior, not uniform auth.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/auth/signup` | Create an account subject to signup policy. |
| `POST` | `/auth/login` | Verify password and create a 30-day server-side session. |
| `POST` | `/auth/logout` | Revoke the current session. |
| `GET` | `/auth/me` | Return the authenticated account. |
| `GET` | `/auth/tokens` | List token metadata without hashes or secret values. |
| `POST` | `/auth/tokens` | Create a token; the raw value is returned once. |
| `DELETE` | `/auth/tokens/{id}` | Revoke a token owned by the account. |

Passwords are hashed. Login performs a dummy hash for missing users to reduce
timing enumeration. Session/API secrets are stored as hashes, token expiry is
enforced, and legacy token comparisons use constant-time primitives.

## Publication validation and ownership

Package names and versions are normalized and validated before they influence a
storage key. Metadata field sizes are bounded. Multipart and JSON publication
share the same name, version, duplicate, and metadata validation. JSON base64 is
decoded only after those cheap checks, and malformed data returns `400`.

When a user API token publishes a core or commit package, the registry records
the authenticated publisher. The legacy operator token represents `_admin` and
does not fabricate a normal publisher identity. Publisher dashboard mutations
verify ownership unless the account is an administrator.

Deletion is deliberately narrower than publication: Zig/PHP deletion currently
uses the operator token, while publisher-account package settings use the account
authorization path. Operators should not expose the legacy token to ordinary CI
jobs when a scoped API token is supported.

## Storage model

The registry separates tarball/blob storage from metadata and analytics:

| Mode | Tarballs and binaries | Metadata | Intended use |
| --- | --- | --- | --- |
| Local | Files under `.registry` or in-memory test storage | Local JSON/in-memory implementations | Development and tests |
| Object storage | S3-compatible provider selected by endpoint, bucket, region, and credentials | Object snapshots such as `metadata/registry-index.json` | Portable production default, including non-AWS providers |
| AWS legacy/compatible | AWS S3 | DynamoDB tables selected by the metadata and analytics settings | Existing AWS deployments and staged migration |

Production supports AWS-compatible and Hetzner object storage. The bucket may
remain private because the server exposes canonical proxy routes. Writes upload
bytes before version metadata. Operators must monitor both steps; an interrupted
operation can require reconciliation even though the API returns success only
after both complete.

`METADATA_BACKEND` explicitly selects `object`, `dynamodb`, or `file`. When it is
unset, an object provider selects the portable object snapshot, a configured AWS
table may retain DynamoDB compatibility, and local operation uses the file
backend. Zig, PHP, authentication, and analytics factories follow the same
deployment distinction: object snapshots are the portable path, while the
DynamoDB implementations remain available when their table variables are set.
Do not mix independently restored generations of these stores.

Important variables include `BASE_URL`, `REGISTRY_INTERNAL_URL`, `S3_BUCKET`,
`S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`,
`METADATA_BACKEND`, `DYNAMODB_TABLE`, `DYNAMODB_ANALYTICS_TABLE`,
`PANTRY_REGISTRY_TOKEN`, `PANTRY_TOKEN`, and `NPM_FALLBACK`. `NPM_FALLBACK=false`
turns missing Pantry metadata into a local miss instead of querying npm. Prefer
the `S3_*` names for portable object storage; legacy `AWS_*` credentials remain
relevant to the AWS-specific backends.

The public `BASE_URL` is stored in metadata and returned to clients. The internal
URL is used for server-side storage proxying when public routing would be
inefficient or recursive. Operators must configure both with valid schemes and
must not point the internal URL at an untrusted host.

## npm fallback and outbound request safety

When enabled, npm fallback can supplement search, metadata, version lists, and
tarball downloads. Local results win and duplicate npm search results are
removed. External tarball URLs must use HTTPS and pass blocked-host checks;
local/private-address targets are rejected to limit SSRF. Pantry-owned tarballs
use a canonical internal storage key derived from validated name and version,
not a user-supplied object key embedded in metadata.

Fallback is a read behavior. A miss in Pantry does not cause an npm package to
be copied or published into Pantry. Disabling fallback is the correct mode for
operators who require the registry to serve only explicitly stored artifacts.

## Analytics and build operations

Public read routes include `/analytics/{name}`, `/analytics/top`, category period
views, `/api/packages`, `/api/build-status`, `/api/github-actions-status`,
`/api/build-events-stream`, `/api/rebuild-queue`, `/api/unavailable-versions`,
and bounded build-log reads. State-changing routes `/analytics/events`,
`/api/build-events`, `/api/build-logs`, and `/api/rebuild` validate bodies and
apply the auth policy in their handler.

The SSE endpoint sends an initial snapshot, event updates, and heartbeat comments,
then cleans up subscriptions and timers on disconnect. Builder ingestion bounds
event batches and log lines to prevent one request from growing memory without
limit. Rebuild package/domain inputs use a restricted character and length set.

Analytics failure must not corrupt package bytes. Download/publish analytics are
best-effort in route families where the handler explicitly catches tracking
errors. Operators should alert on persistent analytics failures without
misreporting them as package-integrity failures.

## HTTP and error contract

| Status | Meaning |
| ---: | --- |
| `200` | Successful read, delete, or accepted operational mutation. |
| `201` | Package or commit publication persisted. |
| `400` | Invalid path parameter, metadata, manifest, JSON, or required field. |
| `401` | Missing/invalid token or server has no required publish token. |
| `404` | Package, version, hash, tarball, or route not found. |
| `409` | Immutable package version already exists. |
| `413` | Tarball exceeds its 50 MiB limit. |
| `415` | Publish content type is unsupported. |
| `500` | Unhandled server/storage failure; no success should be inferred. |

CORS allows public browser reads and declared mutation methods/headers. Cache
headers vary: volatile build state is `no-store`, bounded catalog views use short
public caching, and package bytes are served with explicit content types.

## Operational deployment and recovery

Production deployment must provide a writable metadata/blob backend, stable
public URL, internal URL, operator token, and storage credentials. Keep the
object bucket private unless a separate policy explicitly requires public access.
Use the storage configuration script only with reviewed environment values.

Back up the active metadata backend and package prefixes together. For object
mode this means the metadata snapshots; for DynamoDB mode this means a consistent
table backup. Restoring metadata without corresponding tarballs creates visible
versions that cannot be downloaded; restoring tarballs without metadata leaves unreachable objects.
Reconciliation should compare metadata keys, object keys, checksums, and public
proxy reads before traffic is promoted.

Token rotation is effective immediately for core, commit, Zig, PHP, and admin
handlers that read the current environment; the service environment must itself
be updated. Existing account sessions/API tokens have their own persisted expiry
and revocation lifecycle.

Before a production deployment:

```bash
bun run docs:contracts:check
bun test packages/registry/src
bun run --cwd packages/registry typecheck
curl -fsS https://registry.pantry.dev/health
```

Then verify one real metadata lookup and tarball checksum through the public
proxy. A green health route without a storage read is not end-to-end health.

## Test and evidence map

| Contract | Evidence |
| --- | --- |
| Core metadata, publish, fallback, SSRF, binary proxy, and CORS | `packages/registry/src/e2e.test.ts`, `pkgx-fallback.test.ts` |
| Account, session, API-token, and publisher behavior | `auth.test.ts`, `publisher.test.ts` |
| Immutable commit packages and scoped names | `commit-publish.test.ts` |
| Zig auth rotation, publish, hash, versions, tarball, search, conflict, delete | `zig-routes.test.ts` |
| PHP publish, read, search, conflict, and delete | `php.test.ts` |
| Object metadata, package, and analytics persistence | `object-metadata.test.ts`, `object-package-storage.test.ts`, `object-analytics.test.ts` |
| Workspace range normalization | `workspace-protocol.test.ts` |
| Documentation/source freshness | `scripts/docs-contracts.test.ts`, `bun run docs:contracts:check` |
