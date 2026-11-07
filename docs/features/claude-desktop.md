# Claude Desktop

Claude Code's graphical interface is included in Anthropic's Claude desktop app.
Pantry publishes it separately from the `anthropic.com/claude-code` terminal tool.

On Apple Silicon macOS:

```sh
pantry upgrade
pantry install --user claude-desktop
```

The package identifier is `claude.ai`. `claude-code-desktop` and `claude-app` are
also desktop aliases. The app installs to `~/Applications/Claude.app`; the
existing `claude` terminal executable is kept. Open Claude and sign in to use its
Code tab. Code availability depends on your Anthropic account's plan.

The recipe reads Anthropic's official `RELEASES.json` feed and selects the exact
requested version's ZIP on `downloads.claude.ai`. It refuses mismatched versions
and download hosts. Pantry keeps the signed bundle intact, verifies its identity
and version, and requires macOS code-signature and Gatekeeper checks before
publication. The normal registry malware scan still gates publication.

The daily desktop updater discovers the local app recipe, so future upstream
releases use the same version source and publishing path. App data and sign-in
state are outside the package payload.
