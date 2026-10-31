# Deprecating packages

The registry keeps every version it has published. There is no unpublish:
a build that pinned a version yesterday must still be able to install it
tomorrow. When you want to retire a package, deprecate it instead.

A deprecated package keeps working. Every version still installs, and nothing
is removed. What changes:

- Its metadata says so. Every version the registry serves carries npm's
  `deprecated` field with your message.
- Its page on pantry.dev shows a **Deprecated** notice with your message. So
  does the storefront of a private package that is for sale.
- `pantry install` and `pantry ci` print one warning line when they resolve
  it, then carry on. A deprecated package never fails an install:

  ```text
  warn: @acme/old-sdk@1.4.2 is deprecated: Use @acme/sdk instead
  ```

## Deprecate a package

```bash
pantry deprecate @acme/old-sdk "Use @acme/sdk instead"
```

The message is optional. Without one, the package says
`This package is deprecated`. Quote the message so your shell passes it as one
argument. It is kept to a single line of up to 1024 characters; line breaks
become spaces.

Running the command again replaces the message.

## Undo it

```bash
pantry deprecate @acme/old-sdk --undo
```

The package stops carrying `deprecated`, its page drops the notice, and
installs stop warning.

## Who can deprecate

The package's owner, a member of the owner's [team](paid-packages.md#teams),
or a registry admin. The registry checks this, not the CLI.

`pantry deprecate` authenticates the way `pantry publish` and `pantry access`
do: `--token`, then `PANTRY_REGISTRY_TOKEN` / `PANTRY_TOKEN`, then the
credential `pantry token set` stored. The token needs `publish` permission. A
read-only token or a [package token](private-packages.md#package-tokens-for-ci)
can install the package but can't deprecate it.

`--registry` (or `PANTRY_REGISTRY_URL`) picks another registry, such as one you
[run yourself](self-hosting.md).

| Response | Meaning |
|----------|---------|
| `401` | No credential, or one without `publish` permission |
| `403` | You can see the package but don't manage it |
| `404` | No such package, or a private one this account can't see |

You can also tick **Mark package as deprecated** in the package's settings on
pantry.dev. Both write the same setting.

## Private packages

Deprecating a private package changes nothing else about it. It stays private,
and only the people who could install it before see the deprecation. See
[Private packages](private-packages.md).

## What clients see

The registry adds `deprecated` to the documents it serves for the package:

```http
GET /packages/@acme%2Fold-sdk/1.4.2
```

```json
{
  "name": "@acme/old-sdk",
  "version": "1.4.2",
  "checksum": "sha256:…",
  "deprecated": "Use @acme/sdk instead"
}
```

That is npm's convention for `versions[v].deprecated`: a non-empty string is the
message. The same field is on `GET /packages/{name}` (the latest version) and,
for a private package for sale, on the `402` a non-buyer gets. The field is
derived from the package's settings when the document is served, so it applies
to every version at once, including ones published after you deprecated.

The CLI warns once per package and version in a run. A project whose
dependencies are already installed and match the lockfile asks the registry
nothing, so it has nothing to warn about. A fresh checkout, which is what CI
installs, does.

## API

`{name}` may be URL-encoded (`%40acme%2Fold-sdk`, `@acme%2Fold-sdk`) or raw
(`@acme/old-sdk`).

| Endpoint | Body | Response |
|----------|------|----------|
| `PUT /packages/{name}/deprecation` | `{ message? }` | `200 { name, deprecated: true, message }` |
| `DELETE /packages/{name}/deprecation` | | `200 { name, deprecated: false }` |

`POST` is accepted in place of `PUT`. An empty body or a blank `message` uses
the default message. The publisher dashboard's
`PATCH /publisher/api/packages/{name}` with
`{ settings: { deprecated, deprecationMessage } }` does the same thing. Both
merge into the package's existing settings, so its visibility and npm settings
are kept.
