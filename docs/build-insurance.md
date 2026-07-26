# Build insurance, alerts and SBOMs

Three things a paid plan buys a *consumer* of the registry, all working from the
same input: your lockfile, which is the exact set a build resolved rather than
the ranges a manifest asks for.

See [Plans & Fees](/pricing) for what each plan includes.

## Build insurance

A dependency gets unpublished, retagged, or deleted, and a build that worked
yesterday can't be reproduced today. It has happened to npm, to Go modules and
to container registries, and it will happen again.

```bash
pantry insure
```

Every artifact your lockfile resolves is copied into your org's own namespace
and kept there. When upstream is gone, the mirror still serves the exact bytes.

```bash
pantry insure list          # what's insured, and anything that couldn't be fetched
```

Three details that matter:

- **Bytes are verified before they're stored.** If what upstream serves doesn't
  match the integrity hash in your lockfile, the mirror refuses it and tells you
  — storing it would just mirror the tampering.
- **A retagged version is treated as new.** Identity is (name, version,
  integrity), so republishing `1.0.0` with different bytes is stored alongside
  the original rather than silently replacing it. Both copies stay.
- **Orgs are isolated.** The same tarball pulled by ten orgs is ten copies. A
  mirror that deduped across tenants wouldn't be private, and one org's deletion
  could affect another's builds.

Pull an insured copy directly when you need it:

```
GET /mirror/{name}/{version}/tarball
```

## Continuous alerts

`pantry audit` answers "is my tree vulnerable right now". The dangerous case is
the advisory published next Tuesday for the version you shipped last Tuesday.

```bash
pantry alerts
```

This registers your lockfile and reports everything currently outstanding
against it — so a single command both refreshes what's watched and tells you
what's wrong. Findings exit non-zero, so CI can gate on it.

Vulnerabilities come from [OSV.dev](https://osv.dev), the database GitHub,
Google and the Rust and Go ecosystems publish into. It covers npm, PyPI, Go,
crates.io, Packagist, RubyGems, Maven and NuGet.

Licence policy is yours to set:

```bash
pantry alerts --deny AGPL-3.0,SSPL-1.0     # never acceptable
pantry alerts --allow MIT,Apache-2.0,ISC   # the only acceptable ones
```

An allow-list also flags packages that declare no licence at all — "we don't
know" genuinely fails that rule. A deny-list doesn't, because most packages
without a declared licence aren't the one you're worried about.

Re-registering a lockfile from CI doesn't wipe a policy someone set earlier.

> **If the advisory source can't be reached, the report says so.** An empty
> alert list has to mean "clean" — silently returning one when we couldn't check
> would be the most dangerous possible bug in a security feature.

## SBOM export

```bash
pantry sbom                              # CycloneDX to stdout
pantry sbom --format spdx --out sbom.json
```

CycloneDX 1.5 and SPDX 2.3, both in JSON. Components carry a Package URL, the
declared licence, and hashes — the SHA-256 the mirror computed from the bytes it
actually stored, not a claim copied out of a manifest. That's a real chain:
this is the file, this is its hash, this is where it came from.

Output is deterministic for a given inventory, so regenerating an SBOM doesn't
churn the file in whatever repo it's committed to.

If you've insured your builds, the SBOM describes what was mirrored. If you've
only registered a lockfile for alerts, it describes that instead.

## Team-wide entitlements

On the Team plan, a purchase belongs to the org rather than the person who
clicked Buy: buy a paid package once, and everyone with a seat can install it.
A departing teammate doesn't take the licence with them.

The same applies to everything above — one team shares one mirror, one watch
list and one inventory, and the seat holder's plan governs throughout.

## API

| Endpoint | Purpose |
|----------|---------|
| `POST /mirror/snapshot` | Record and store what you installed |
| `GET /mirror` | What's insured, with stats |
| `GET /mirror/{name}/{version}/tarball` | Serve the insured copy |
| `PUT /security/watch` | Register a lockfile (and optionally a licence policy) |
| `PUT /security/policy` | Set the licence policy on its own |
| `GET /security/alerts` | Everything currently outstanding |
| `GET /sbom?format=cyclonedx\|spdx` | Export an SBOM |

All are authenticated with your registry token and answer to your org — the seat
holder when you're on a team, otherwise yourself.
