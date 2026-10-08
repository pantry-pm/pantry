# Moving from npm tokens to OIDC

This guide moves an existing release workflow that publishes with an
`NPM_TOKEN` secret to trusted publishing (OIDC), then removes the token.

You can do it without a broken release in between: pantry tries OIDC first and
falls back to the token, so the token keeps working until OIDC is set up.

## Before

```yaml
- run: npm publish --access public
  env:
    NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

or, with pantry:

```yaml
- run: pantry publish --npm --access public
  env:
    NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
```

## 1. Switch the publish step to pantry and add `id-token: write`

Keep the token for now.

```yaml
jobs:
  npm:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      id-token: write

    steps:
      - uses: actions/checkout@v6
      - uses: pantry-pm/pantry/packages/action@main
        with:
          install: 'false'
      - run: bun install
      - run: bun run build
      - run: pantry publish --npm --access public --ignore-scripts
        env:
          NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
```

Run from the repository root, this publishes every package in `packages/`. See
[Publishing to npm](./NPM_OIDC_PUBLISHING.md) for how a monorepo run works.

Until a package has a trusted publisher, its OIDC attempt fails without
uploading anything, and pantry publishes it with the token.

## 2. Trust the workflow

On your machine, from the repository root:

```bash
unset NPM_TOKEN NODE_AUTH_TOKEN BUN_AUTH_TOKEN
pantry login
pantry publisher:add --repository my-org/my-lib --workflow release.yml
pantry publisher:list
```

`publisher:add` needs the login session. An automation or granular token that
bypasses two-factor is refused by npm for this. See
[Trusted publishing](./OIDC_AUTHENTICATION.md).

## 3. Release once

Cut a release. Each package now publishes with OIDC and provenance. If one
still falls back to the token, the log says why:

```text
OIDC publish failed (401): OIDC authentication failed. Check trusted publisher configuration on npm.
If this package has no trusted publisher, configure one:
  https://www.npmjs.com/package/<name>/access

Falling back to token authentication...
```

Fix it with `pantry publisher:add --package <name> …` and release again.

## 4. Remove the token

When a release has gone out entirely through OIDC:

1. Delete the `env: NPM_TOKEN` lines from the workflow.
2. Delete the secret: `gh secret delete NPM_TOKEN --repo my-org/my-lib`.
3. Revoke the token on npm: <https://www.npmjs.com/settings/tokens>.

From then on, a package that can't publish with OIDC fails the run instead of
falling back. Its dependents in the same run are held back rather than
published uninstallable.

## Rolling back

Put the `NPM_TOKEN` secret and `env` lines back. pantry uses the token whenever
OIDC fails. Trusted publishers don't need to be removed; to remove one anyway:

```bash
pantry publisher:list --package <name>
pantry publisher:remove --package <name> --publisher-id <id>
```

## Checklist

- [ ] Publish step is `pantry publish --npm` from the repository root
- [ ] Job has `permissions: id-token: write`
- [ ] `pantry login`, then `pantry publisher:add` for every package
- [ ] `pantry publisher:list` shows the right workflow file
- [ ] One release published through OIDC
- [ ] `NPM_TOKEN` removed from the workflow and the repository secrets
- [ ] Token revoked on npm
