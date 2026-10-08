# Set up OIDC publishing for a monorepo

This walkthrough sets up tokenless npm publishing for every package in a
monorepo. When you're done, a GitHub Actions workflow publishes with OIDC and
Sigstore provenance, and no npm token is stored anywhere.

It takes four steps: log in, trust the workflow, write the workflow, revoke the
old tokens.

## Before you start

- Every package you want to set up is already on npm. npm can't attach a
  trusted publisher to a package that doesn't exist yet. For a new package,
  publish it once from your machine first: `pantry login`, then
  `pantry publish --npm` from the repository root.
- Your npm account can administer those packages.
- For scoped packages, the npm organization exists and your account is in it.

## 1. Log in

```bash
pantry login
```

pantry opens npm's login page in your browser. Sign in, with two-factor, and
pantry saves the session token to `~/.npmrc` and prints who you are.

Trusted publishing settings need this login session. npm refuses automation
and granular tokens that bypass two-factor for account changes like this one.

If `NPM_TOKEN` (or `NODE_AUTH_TOKEN`, `BUN_AUTH_TOKEN`) is set in your shell,
pantry uses it instead of the login. Unset it first:

```bash
unset NPM_TOKEN NODE_AUTH_TOKEN BUN_AUTH_TOKEN
```

## 2. Trust the release workflow

From the repository root:

```bash
pantry publisher:add --repository my-org/my-lib --workflow release.yml
```

Without `--package`, pantry sets up every publishable package under
`packages/` (the same packages `pantry publish --npm` would publish):

```text
Trusting my-org/my-lib (release.yml) to publish with OIDC:
  @my-lib/react
  @my-lib/vue
  my-lib

  npm wants two-factor approval. Approve it in your browser:
    https://www.npmjs.com/auth/cli/…
  Waiting for approval...
  ✓ @my-lib/react
  ✓ @my-lib/vue
  ✓ my-lib (already trusted: …)

Publishing from my-org/my-lib with `pantry publish --npm` now uses OIDC, with provenance.
```

npm asks for two-factor. When it offers browser approval, pantry opens the page
and waits; one approval covers the rest of the run while npm accepts it.
Otherwise pantry asks for a code from your authenticator. In a shell that can't
answer a prompt, pass the code up front:

```bash
pantry publisher:add --repository my-org/my-lib --workflow release.yml --otp 123456
```

Check the result:

```bash
pantry publisher:list
```

See [Trusted publishing](./OIDC_AUTHENTICATION.md) for every option.

## 3. Write the workflow

Save this as `.github/workflows/release.yml`. The file name must match
`--workflow` from step 2.

```yaml
name: Release

on:
  push:
    tags:
      - 'v*'
  workflow_dispatch:

jobs:
  npm:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      id-token: write # required for OIDC

    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0

      - uses: pantry-pm/pantry/packages/action@main
        with:
          install: 'false'

      - run: bun install

      - run: bun run build

      - run: pantry publish --npm --access public --ignore-scripts
```

What the publish step does:

- publishes every non-private package in `packages/`, dependencies first;
- rewrites `workspace:` and `catalog:` ranges to real versions;
- skips versions that are already on npm, so re-running publishes only what's
  missing;
- holds back a package whose dependency failed in the same run;
- builds nothing itself, because `--ignore-scripts` skips `prepublishOnly` and
  the other lifecycle scripts. The build step before it does that once.

Tag a release to run it:

```bash
git tag v1.0.0
git push origin v1.0.0
```

On npm, each version published this way shows provenance that links to the
workflow run.

## 4. Revoke the old tokens

Once a release has gone out with OIDC:

1. Remove the token secret from the repository:

   ```bash
   gh secret delete NPM_TOKEN --repo my-org/my-lib
   ```

2. Delete the token on npm: <https://www.npmjs.com/settings/tokens>.
3. Remove the `NPM_TOKEN` env line from the workflow, if it's still there.

With no token in CI, a failed OIDC exchange fails the publish instead of
quietly falling back to a token.

## Adding a package later

A new package needs one publish before it can be trusted:

```bash
pantry login
pantry publish --npm --access public ./packages/new-package
pantry publisher:add --package @my-lib/new-package --repository my-org/my-lib --workflow release.yml
```

## If something fails

| Message | Fix |
| --- | --- |
| `No npm auth token found` | Run `pantry login`. |
| `This token skips two-factor…` | You're using an automation or granular token. Unset `NPM_TOKEN` and run `pantry login`. |
| `npm needs a one-time password; pass --otp <code>` | The shell couldn't prompt. Re-run with `--otp`. |
| `404 … isn't on npm yet, or that this account can't administer` | Publish the package once, or log in as a maintainer. |
| `OIDC publish failed (401): OIDC authentication failed` in CI | The workflow file name, repository, or environment doesn't match. Check `pantry publisher:list`. |

More in [Publishing to npm](./NPM_OIDC_PUBLISHING.md#troubleshooting).
