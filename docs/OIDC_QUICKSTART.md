# OIDC quick start: one package

Publish a single npm package from GitHub Actions without an npm token. For a
monorepo, follow [Set up OIDC publishing for a monorepo](./NPM_OIDC_QUICKSTART.md)
instead; the steps are the same, run from the repository root.

## 1. Log in and publish once

npm can't trust a workflow for a package that doesn't exist yet. If the package
isn't on npm, publish the first version from your machine:

```bash
pantry login
pantry publish --npm --access public
```

`pantry login` opens npm in your browser and saves a login session to
`~/.npmrc`. Unset `NPM_TOKEN` first if it's set: pantry uses it before the
npmrc.

## 2. Trust the workflow

In the package directory:

```bash
pantry publisher:add --repository my-org/my-package --workflow publish.yml
```

Approve the two-factor request in your browser, or enter the code when asked.
Pass `--otp <code>` if the shell can't prompt.

## 3. Add the workflow

`.github/workflows/publish.yml`:

```yaml
name: Publish

on:
  release:
    types: [published]

jobs:
  publish:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write # required for OIDC

    steps:
      - uses: actions/checkout@v6

      - uses: pantry-pm/pantry/packages/action@main
        with:
          install: 'false'

      - run: pantry publish --npm --access public
```

The file name must match `--workflow`. Use `--npm`: without it,
`pantry publish` targets the Pantry registry.

## 4. Release

Create a GitHub release. The workflow publishes with OIDC and attaches
provenance. A version that's already on npm is skipped, so re-running the
workflow is safe.

## Common problems

| Problem | Fix |
| --- | --- |
| `No npm auth token found` from `publisher:add` | Run `pantry login`. |
| `This token skips two-factor…` | Unset `NPM_TOKEN` and run `pantry login`. |
| `404 … isn't on npm yet` from `publisher:add` | Publish the package once (step 1). |
| `OIDC publish failed (401)` in CI | The repository, workflow file name, or environment doesn't match. Run `pantry publisher:list`. |
| `Could not get OIDC token from environment` | Add `id-token: write` to the job's permissions. |

## Next

- [Publishing to npm](./NPM_OIDC_PUBLISHING.md): every option, authentication
  order, and troubleshooting.
- [Trusted publishing](./OIDC_AUTHENTICATION.md): `publisher:add`,
  `publisher:list`, `publisher:remove`.
