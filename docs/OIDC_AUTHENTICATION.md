# Trusted publishing (OIDC)

Trusted publishing lets a CI workflow publish to npm without an npm token. You
tell npm which workflow may publish a package. In that workflow,
`pantry publish --npm` gets an identity token from the CI provider, npm checks
it against your settings and hands back a short-lived publish token for that
one package, and pantry publishes with Sigstore provenance.

pantry manages these settings with three commands:

- `pantry publisher:add` trusts a workflow to publish.
- `pantry publisher:list` shows what's trusted.
- `pantry publisher:remove` stops trusting one.

They use npm's trust API (`/-/package/<name>/trust`), the same one `npm trust`
uses, so settings made with either tool show up in both and on npmjs.com.

For a full setup from scratch, see
[Set up OIDC publishing for a monorepo](./NPM_OIDC_QUICKSTART.md).

## How it works

1. You run `pantry login` once, then `pantry publisher:add`. npm records that
   the workflow file `release.yml` in `my-org/my-lib` may publish the package.
2. The workflow runs with `permissions: id-token: write`.
3. `pantry publish --npm` requests an identity token from GitHub for the
   audience `npm:registry.npmjs.org`.
4. npm checks the token's repository, workflow file, and environment against
   the trusted publisher, and returns a publish token for that package.
5. pantry signs provenance with Sigstore and publishes. The publish token
   expires shortly after.

If any step fails, pantry falls back to an npm token if one is available. See
[When OIDC fails](./NPM_OIDC_PUBLISHING.md#when-oidc-fails).

## Requirements

- **A login session.** Every trust command needs two-factor, and npm refuses
  automation and granular tokens that bypass two-factor for account changes
  such as these. Run `pantry login` first. An `NPM_TOKEN`, `NODE_AUTH_TOKEN`,
  or `BUN_AUTH_TOKEN` in the environment is used before the login, so unset it.
- **The package exists on npm.** npm answers 404 for a package that isn't
  published yet. Publish it once with your login, then add the publisher.
- **Your account can administer the package.**
- **A supported CI.** pantry sets up GitHub Actions and GitLab CI/CD
  publishers. For CircleCI, use `npm trust circleci`.

## `pantry publisher:add`

```bash
pantry publisher:add --repository <owner/repo> --workflow <file> [options]
```

Trusts a workflow to publish packages with OIDC.

| Option | What it does |
| --- | --- |
| `--repository <owner/repo>` | Required. The repository, as `owner/repo`. For GitLab, the project path. |
| `--owner <owner>` | The owner, if `--repository` is only the repository name. |
| `--workflow <file>` | Required. The workflow that publishes: `release.yml` or `.github/workflows/release.yml`. npm stores the file name only, so a path is cut down to its last segment. For GitLab, the pipeline file, such as `.gitlab-ci.yml`. |
| `--environment <name>` | Only trust jobs that run in this environment. |
| `--type <type>` | `github-action` (default) or `gitlab-ci`. |
| `--package <name>` | Set up this package only. |
| `--otp <code>` | One-time password, when you can't answer a prompt. |
| `--registry <url>` | Default: `https://registry.npmjs.org`. |

### Which packages

- With `--package`, that package.
- Without it, at a monorepo root, every publishable package under `packages/`:
  the same non-private packages `pantry publish --npm` publishes.
- Without it, in a single package's directory, that package.

```bash
# Every package of the monorepo here
pantry publisher:add --repository my-org/my-lib --workflow release.yml

# One package, with --owner and a path
pantry publisher:add --package @my-lib/react \
  --owner my-org --repository my-lib \
  --workflow .github/workflows/release.yml

# Only jobs in the "npm" environment
pantry publisher:add --repository my-org/my-lib --workflow release.yml --environment npm

# GitLab
pantry publisher:add --type gitlab-ci --repository my-group/my-project --workflow .gitlab-ci.yml
```

### Two-factor

npm requires two-factor for each trust change:

- When npm offers browser approval, pantry opens the approval page, prints its
  URL, and waits up to five minutes.
- Otherwise pantry asks for the code from your authenticator.
- In CI, or any shell that can't answer a prompt, pass `--otp <code>`. Without
  it, each package fails with `npm needs a one-time password; pass --otp <code>`.

The code or approval is reused for the next package, so a monorepo usually
needs one approval.

### Output

Each package gets a line:

```text
Trusting my-org/my-lib (release.yml) to publish with OIDC:
  @my-lib/react
  my-lib
  ✓ @my-lib/react
  ✓ my-lib (already trusted: …)

Publishing from my-org/my-lib with `pantry publish --npm` now uses OIDC, with provenance.
```

A package that already has this trusted publisher is reported as already
trusted and counts as success. The command exits non-zero if any package
wasn't set up, with npm's reason on that package's line, plus a hint when:

- the token bypasses two-factor: log in with `pantry login` and run it again;
- npm didn't accept the token (401): log in with `pantry login`;
- npm answered 404: the package isn't on npm yet, or this account can't
  administer it.

A package name with a non-ASCII character, such as a fullwidth `＠` pasted from
a web page, is rejected before anything is sent.

## `pantry publisher:list`

```bash
pantry publisher:list [--package <name>] [--json]
```

Shows each trusted publisher's id, type, repository, workflow file, and
environment. Without `--package`, it lists every publishable package here, as
`publisher:add` does.

```text
@my-lib/react:
  <id>  github my-org/my-lib release.yml (environment npm)
my-lib: no trusted publishers
```

| Option | What it does |
| --- | --- |
| `--package <name>` | List this package only. |
| `--json` | Print npm's answers as one JSON object keyed by package name. A package that failed is `null`. |
| `--otp <code>` | One-time password, if npm asks for one. |
| `--registry <url>` | Default: `https://registry.npmjs.org`. |

## `pantry publisher:remove`

```bash
pantry publisher:remove --package <name> --publisher-id <id> [--otp <code>]
```

Stops trusting a publisher. Take the id from `pantry publisher:list`.

```bash
pantry publisher:list --package @my-lib/react
pantry publisher:remove --package @my-lib/react --publisher-id <id>
```

| Option | What it does |
| --- | --- |
| `--package <name>` | Required. |
| `--publisher-id <id>` | Required. |
| `--otp <code>` | One-time password, when you can't answer a prompt. |
| `--registry <url>` | Default: `https://registry.npmjs.org`. |

Two-factor works as it does for `publisher:add`.

## The workflow

GitHub Actions needs `id-token: write`:

```yaml
permissions:
  contents: read
  id-token: write

steps:
  - uses: actions/checkout@v6
  - uses: pantry-pm/pantry/packages/action@main
    with:
      install: 'false'
  - run: pantry publish --npm --access public
```

If you set `--environment`, run the job in it:

```yaml
jobs:
  npm:
    runs-on: ubuntu-latest
    environment: npm
```

For GitLab, pantry reads the identity token from `CI_JOB_JWT_V2`:

```yaml
publish:
  id_tokens:
    CI_JOB_JWT_V2:
      aud: npm:registry.npmjs.org
  script:
    - pantry publish --npm --access public
```

See [Publishing to npm](./NPM_OIDC_PUBLISHING.md#github-actions) for a complete
monorepo release workflow.

## Provenance

With OIDC, pantry signs a provenance statement with Sigstore and sends it with
the publish. npm shows it on the package page, linked to the workflow run that
built the version. `--no-provenance` publishes with OIDC but without it.
Publishing with a token never attaches provenance.

## `pantry oidc setup`

`pantry oidc setup` reads the package name, the GitHub repository, and a
workflow file from the current directory and prints instructions for adding
the trusted publisher on npmjs.com by hand. It changes nothing. Use
`pantry publisher:add` to make the change directly.

## Related

- [Publishing to npm](./NPM_OIDC_PUBLISHING.md)
- [Set up OIDC publishing for a monorepo](./NPM_OIDC_QUICKSTART.md)
- [Moving from npm tokens to OIDC](./OIDC_MIGRATION_GUIDE.md)
- [npm: trusted publishers](https://docs.npmjs.com/trusted-publishers)
