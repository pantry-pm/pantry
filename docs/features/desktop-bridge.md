# Desktop catalog and installation bridge

The public `catalog/packages.json` snapshot covers Pantry packages, desktop applications, and fonts. `catalog/logos.json` records original artwork URLs and SHA-256 digests. Artwork bytes are retained in `assets/package-logos/` and served through GitHub raw URLs. Projects without verified artwork have no logo entry.

Use `ts-pantry/catalog` for validated discovery and local search. It bundles a complete snapshot and can refresh from Pantry's GitHub repository without sending a search query. Use `ts-pantry/desktop` for the transport client. Both entrypoints bundle for browsers and contain no installer implementation.

## Connect an application

Install the Pantry CLI separately, then run `pantry desktop setup --yes` in your terminal. This compiles and starts Pantry's per-user desktop service now and at login. Enter its eight digit pairing code in the application within five minutes. Later connections can use `pantry desktop pair` to generate another code.

The desktop service listens only on `127.0.0.1:46473`. Pairing codes expire and work once. Applications keep their bearer token in the operating system credential store. Pantry retains only the token hash in owner-only files. Each application can revoke its own connection.

Installations run the native CLI with fixed argument arrays, without a shell or administrator elevation. Targets must be exact catalog identifiers. Command line tools and libraries use `pantry install --user <domain>`. Applications and fonts add `--kind app` or `--kind font`, activating downloaded artifacts in `~/Applications` or `~/Library/Fonts`. Artwork and metadata do not prove a compatible artifact exists; an unavailable artifact fails visibly.

Install jobs have client-owned IDs, bounded output, persistent status, a serial queue, and UUID retry keys. Reusing a retry key returns the existing job. Pantry does not silently restart interrupted installations after a service restart.

An App Store application may use the catalog and transport client, with the installer in the independently installed Pantry process. This architecture does not establish compliance with Apple's rules about installation or executable code. Describe the actual behavior in review notes and obtain Apple's approval before claiming Store availability.

## Native Apple publishing

Stacks native projects invoke the same Pantry pipeline through Buddy:

- `buddy desktop:apple:package` qualifies and signs the Store package.
- `buddy desktop:apple:publish --build-number 12` qualifies, uploads, waits for processing, attaches the build, and prepares listing metadata.
- `buddy desktop:apple:publish --validate-only` validates the signed package with Apple without uploading it.
- `buddy desktop:apple:submit --build-number 12 --submit-for-review` submits a build already uploaded by CI without rebuilding it.

Enable `native.macos.appStore` in `pantry.json`. Keep listing metadata in `app-store.config.ts` or JSON. `NativeAppStoreMetadata` permits private review contact fields in encrypted `APP_STORE_REVIEW_CONTACT`, with public `reviewNotes` in the metadata file. Signing and API credentials use the existing encrypted native release environment.

## Publishing native apps to Pantry

Set `native.registry.domain` in `pantry.json`, for example `github.com/your-org/your-app`. Keep `native.macos.notarize` enabled. The native release action qualifies the app, staples its own notarization ticket, archives the Developer ID bundle and publishes it through Pantry's staged, malware-scanned binary API. The Store-signed bundle is reserved for Apple delivery. The archive and a credential-free publication receipt are attached to the GitHub release.

The caller of `pantry-pm/pantry/.github/workflows/native-app.yml` passes `PANTRY_TOKEN` as an optional workflow secret. Registry publication runs only for releases whose manifest enables that target. Checks and pull requests need no registry credential.

Application archives carry their `.app` bundle directly. Pantry validates the bundle manifest and a non-empty executable before materialization, preserving the bundle and its notarization ticket. The catalog's `programs` field lists exported command line tools; a GUI-only application declares an empty list.

Registry operators issue an application token with `pantry registry token issue releases@example.com --publish --binary-domain github.com/your-org/your-app --expires-in-days 365`. The member account must exist first. Store its returned token with `pantry token set --registry https://registry.pantry.dev` using stdin, then run `pantry token sync --registry https://registry.pantry.dev --repo your-org/your-app`. Ordinary account tokens cannot grant native package access. A native token can publish only its exact approved domains and complete only uploads initiated by its account. Retained-artifact rescans remain operator-only.

`publishNativeRegistry` and `publishPreparedNativeRegistry` from `ts-pantry/native` expose the same release target to other hosts. The first qualifies the project; the second publishes the already-qualified pipeline result. Original application artwork belongs in the shared catalog logo manifest, with its upstream source and SHA-256 recorded.
