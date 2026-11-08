# Automatic desktop app updates

The existing daily `check-desktop-updates.yml` workflow discovers every recipe
under `recipes/apps/`, every font recipe, and every entry in the local desktop
catalog. Slash-domains outside the apps directory participate too. Recipe
version sources are authoritative: GitHub product tags, vendor appcasts, official
JSON metadata and download redirects all run with bounded requests. A missing or
failed source is an error; it cannot silently mark the app current.

The discovery job produces one immutable JSON plan. Both publishing jobs consume
that exact plan, so a vendor releasing again during publication cannot change
half the run. Portable archives publish from Ubuntu; disk images, package
installers and signature checks use a Mac only when the plan contains native work.

Vendors that expose only a rolling archive use `desktop-bundle` sources. HTTP
validators decide whether native discovery is needed. A changed archive is
inspected with macOS tools to read its real bundle version; its fingerprint is
checked again around download. Spotify and TablePlus use the marketing version;
Logitech's installer declares only `CFBundleVersion`, which is selected explicitly.
The next unchanged run allocates no Mac for that source.

Publication builds each maintained target separately and registers only those
bytes under that target. A Mac ZIP built on Ubuntu is published as darwin-arm64,
never as Linux and never under a different CPU. No new Intel Mac artifacts are
produced. Older Intel artifacts remain available.

Application bundles preserve vendor signatures and pass executable, architecture
and actual bundle-version checks before packaging. Native builds additionally
verify signed bundles with codesign. Every upload still goes through the registry's
malware scan gate. Successful publication requires registry metadata for every
required target, a non-empty tarball, a SHA-256 and a clean scan bound to that digest.

Vendor bundle formats can declare an anchored product-version capture, such as
Brave’s Chromium-prefixed version. The expected product version must still match
exactly. Vendors whose release tags disagree with their bundles, such as
MeetingBar, use fingerprint-bound native bundle discovery instead. Copies omit
Finder metadata and resource forks while retaining the signed file bytes.

Registry restarts preserve the built artifact and retry the same staged upload
within a bounded deadline, honoring `Retry-After`. Malware detections remain
terminal failures. One failed package does not stop the remaining packages from publishing. The run
reports all failures and cannot record an incomplete manifest. The final writer
merges native discovery receipts, verifies the public registry, then commits via
the existing checked-push workflow. Reports and discovery do not modify the manifest.

Bitwarden's `bw` CLI retains `bitwarden.com`. The desktop app has the separate
`bitwarden.com/desktop` domain and `bitwarden-desktop` alias, preventing either
product from overwriting the other's catalog entry or executable.
