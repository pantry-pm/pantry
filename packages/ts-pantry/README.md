# ts-pantry

TypeScript types for Pantry package manager configuration with **full type validation** for package names and versions.

## Installation

```bash
bun add -d ts-pantry
```

## Usage

```typescript
import type { PantryConfig } from 'ts-pantry'

export const config: PantryConfig = {
  dependencies: {
    'bun.com': '^1.3.0',      // ✅ Valid
    'sqlite.org': '^3.47.2',  // ✅ Valid
    // 'bun.com': '^999.999.999',  // ❌ TypeScript error: invalid version!
    // 'fake-pkg': 'latest',      // ❌ TypeScript error: package doesn't exist!
  },

  services: {
    enabled: true,
    autoStart: true,
    database: {
      connection: 'sqlite',
      name: 'myapp',
    },
  },

  verbose: true,
}

export default config
```

## Features

- **Full Type Validation**: Package names and versions are validated at compile time
- **IntelliSense Support**: Get autocomplete for all 3000+ packages from the pkgx registry
- **Version Validation**: Invalid versions trigger TypeScript errors
- **Zero Configuration**: Just import and use - no additional setup required
- **App Store Automation**: Provision macOS identifiers, capabilities, certificates,
  and profiles, then manage App Store versions and processed builds

## App Store Connect

Pantry owns the provider-neutral Apple distribution layer used by release actions
and framework integrations. Authentication defaults to
`APP_STORE_CONNECT_API_KEY_ID`, `APP_STORE_CONNECT_API_ISSUER_ID`, and
`APP_STORE_CONNECT_API_KEY_PATH`.

Provisioning is plan-only unless `checkOnly: false` is explicitly passed. It
reuses active certificates and profiles and never revokes existing resources.
Apple requires the initial app record to be created manually in App Store
Connect; Pantry reports that remaining action in its result.

```bash
# Generate the two private-key/CSR pairs locally.
ts-pantry app-store:csr --name "Example Desktop"

# Safe plan (no Apple resources are changed).
ts-pantry app-store:provision \
  --bundle-id com.example.desktop \
  --name "Example Desktop"

# Apply after supplying CSRs for any missing certificates.
ts-pantry app-store:provision \
  --bundle-id com.example.desktop \
  --name "Example Desktop" \
  --app-certificate-csr .pantry/apple/mac-app-distribution.csr \
  --installer-certificate-csr .pantry/apple/mac-installer-distribution.csr \
  --apply
```

```typescript
import {
  AppStoreConnectClient,
  ensureAppStoreVersions,
  provisionMacApp,
  waitForAppStoreBuilds,
} from 'ts-pantry'

const plan = await provisionMacApp({
  identifier: 'com.example.desktop',
  name: 'Example Desktop',
  capabilities: ['APP_GROUPS'],
})

const client = new AppStoreConnectClient()
const app = await client.findApp('com.example.desktop')
if (app) {
  const versions = await ensureAppStoreVersions(client, app.id, [
    { platform: 'MAC_OS', version: '1.0.0' },
  ])
  await waitForAppStoreBuilds(client, app.id, versions, '42')
}
```

## Type Definitions

### `PantryConfig`

Main configuration interface for Pantry with all available options.

### `Dependencies`

Type-safe dependency specification with version constraints.

### Helper Functions

- `definePantryConfig(config)` - Helper to define configuration with full type safety
- `defineDependencies(deps)` - Helper to define dependencies with type checking
- `definePackageList(packages)` - Helper to define package arrays

## License

MIT

### App Store submission

`AppStoreConnectClient`, `ensureAppStoreVersions`, and `waitForAppStoreBuilds`
manage Apple app versions and processed builds. `prepareAppStoreSubmission`
applies typed `AppStoreMetadata`: pricing, territories, categories, age rating,
localized descriptions, review contact and screenshots. Screenshot uploads use
Apple's reusable App Asset Library and discover eligible placement groups from
the current reference catalog. Supply `screenshots: [{ platform:
'MAC_APP_STORE', files: ['screenshots/main.png'] }]`; iPhone and iPad groups use
`IPHONE_APP_STORE` and `IPAD_APP_STORE`. Legacy screenshot display-type keys
remain accepted. Pass `submit: true` only
when the prepared version should enter App Review. `submitAppStore` prepares an
already-uploaded version by bundle ID and version, and preserves active review
submissions when a release command is retried. These APIs work for macOS and iOS
apps, independently of the application framework or an extension container.

## Native application releases

Pantry owns native runtime provisioning, temporary signing credentials,
notarization, App Store packaging and delivery, Google Play delivery, and
verified GitHub release assets. Buddy owns compilation. App repositories keep
application metadata in `craft.config.ts` and declare release policy in
`pantry.json`; they do not need platform scripts or entitlement XML.

```json
{
  "native": {
    "environment": "production",
    "runtime": {
      "revision": "1fb96b37dc6c30a431570c0902df5aa8a70c911c",
      "version": "0.0.355"
    },
    "checks": {
      "before": [["bun", "run", "lint"], ["bun", "run", "test:unit"]],
      "after": [["bun", "run", "test:native"]]
    },
    "macos": {
      "notarize": true,
      "entitlements": { "direct": { "com.apple.security.cs.allow-jit": true } }
    }
  }
}
```

Use the versioned `pantry-pm/pantry/.github/workflows/native-app.yml` reusable
workflow with `release: true` on version tags, and the versioned
`native-check.yml` workflow for read-only CI.
Pass `secrets: inherit` for releases. Create `.env.production` with
`buddy env:set KEY --stdin --file .env.production`, commit its authenticated
ciphertext, and keep `.env.keys` ignored. The release workflow receives only
`DOTENV_PRIVATE_KEY_PRODUCTION`; the other provider credentials below belong
in the encrypted file. Pantry uses the same whole-file reader and scoped key
resolver as Buddy, masks decrypted values before running commands, and never
writes plaintext credentials back to the repository. CI audits ciphertext
without receiving the decryption key. Missing, wrong or partial decryption
fails before signing or publication.

The workflow installs dependencies from the
lockfile, runs all declared checks, provisions the immutable Craft source with
its locked Zig compiler, resolves and hash-verifies current dependencies through
Zig's native package manifest, builds through Buddy, and checks
the actual bundle's identity, size, Mach-O executable and native launch. Pinned
older Craft revisions keep their declared sibling-source pins; malformed pins
fail rather than switching dependency contracts. Native checks remain app-owned and run against the real artifact. Release tags must
match `package.json`. Releases reject the local `CRAFT_BIN` development override.

Direct macOS releases require `APPLE_APPLICATION_CERTIFICATE` (base64 P12),
`APPLE_CERTIFICATE_PASSWORD`, and, for restricted capabilities,
`APPLE_PROVISIONING_PROFILE_BASE64` in the encrypted environment. Notarization accepts App Store Connect
`APP_STORE_CONNECT_API_KEY_ID`, `APP_STORE_CONNECT_ISSUER_ID` and
`APP_STORE_CONNECT_PRIVATE_KEY`, or the `APPLE_ID`,
`APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` alternative. Local runs can use
`APPLE_NOTARY_KEYCHAIN_PROFILE` or `APP_STORE_CONNECT_API_KEY_PATH` instead.
Pantry selects the imported certificates by fingerprint, signs the outer DMG
with a secure timestamp, and requires Gatekeeper to accept both the app and
the notarized DMG. Only Apple's Accepted status allows stapling; explicit
ticket-service transport failures receive bounded retries, while invalid or
revoked tickets fail immediately. The stapled file is hashed for the release
receipt. A configured target with missing credentials fails before the
build. Check runs receive no publishing secrets.

Enable `native.macos.appStore: true` to build a separate sandboxed distribution
and signed PKG. Declare `entitlements.appStore` including a true
`com.apple.security.app-sandbox`; provide
`APPLE_APP_STORE_APPLICATION_CERTIFICATE`, `APPLE_APP_STORE_INSTALLER_CERTIFICATE`,
and `APPLE_APP_STORE_PROVISIONING_PROFILE_BASE64` in addition to the Connect API
credentials. The API upload is validated and a receipt is attached. This is
App Store Connect delivery, not an assertion that Apple approved a review.
Apple enrollment, account agreements and initial account credentials remain
account-owner setup; Pantry's existing provisioning APIs handle certificates,
bundle IDs, profiles and Connect resources.

Android apps declare `native.android` with `bundle` (an AAB path), `packageName`,
`track`, and explicit `status` (`draft`, `completed`, or `inProgress` with a
`userFraction` between zero and one). Their `native.build` is an argument array
for the project's native compiler. Pantry signs with `ANDROID_KEYSTORE_BASE64`,
`ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD`, or
verifies the compiler's already-signed AAB. `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`
provides the publisher account. Pantry checks the upload SHA-256 and version
code, updates the configured track in an edit, validates it, and commits only
after those steps pass. Failed or validation-only edits are deleted. A commit
never implicitly cancels another in-progress store review. Play app enrollment
and granting the service account access are initial account-owner setup.

For local validation use `ts-pantry native:check`; for signed release artifact
preparation use `ts-pantry native:prepare-release`. The public
`ts-pantry/native` entry exports the same runtime, build, signing, notarization,
App Store and Google Play operations used by Buddy and the GitHub Action.

`exportAppleKeychainIdentity` exports exactly one existing macOS identity by
certificate fingerprint through Security.framework. Its P12 password is supplied
through the child environment, and unrelated identities are never exported.
It supports migrating a local signing identity into Buddy-encrypted CI settings.

`buddy release --bump patch|minor|major` delegates native app qualification and
versioning to `releaseNativeApp`. It requires clean source on `main`, runs the
configured artifact and native checks first, then uses the shared bumpx
publisher to commit, tag and push normally. The tag invokes the Pantry delivery
workflow. `ts-pantry native:release --bump patch` exposes the same operation;
`--dry-run` previews the version change after qualification without committing,
tagging or pushing.

### Desktop catalog and connections

`ts-pantry/catalog` provides the complete validated public package snapshot and local search. `ts-pantry/desktop` provides an authenticated transport client for the separately installed Pantry desktop service. They contain no installer and bundle for browsers. The external CLI owns installation, pairing, job persistence and activation of apps, CLIs, libraries and fonts. See [desktop bridge documentation](../../docs/features/desktop-bridge.md).

Native Stacks projects use `buddy desktop:apple:package`, `buddy desktop:apple:publish` and `buddy desktop:apple:submit` for the shared Apple delivery pipeline. The native SDK also exports `publishNativeApple` and `submitNativeApple` for other hosts.
