<p align="center"><img src=".github/art/cover.jpg" alt="Social Card of this repo"></p>

[![npm version][npm-version-src]][npm-version-href]
[![GitHub Actions][github-actions-src]][github-actions-href]
[![Commitizen friendly](https://img.shields.io/badge/commitizen-friendly-brightgreen.svg)](http://commitizen.github.io/cz-cli/)
<!-- [![npm downloads][npm-downloads-src]][npm-downloads-href] -->
<!-- [![Codecov][codecov-src]][codecov-href] -->

# pantry Installer

A GitHub Action to install system dependencies using pantry.

## Usage

This action allows you to easily install dependencies with pantry in your GitHub Actions workflows.

```yaml

- name: Install Dependencies with pantry

  uses: pantry-pm/pantry-installer@v1
# Automatically detects and installs project dependencies
# Optional parameters
# with
# packages: node python go # override auto-detection
# config-path: pantry.config.ts
```

## Inputs

| Name       | Description                           | Required | Default              |
|------------|---------------------------------------|----------|----------------------|
| packages   | Space-separated list of packages to install (overrides auto-detection) | No  | (empty) - auto-detects from project files |
| services   | Space-separated CI services to install, start, health-check, and stop; Redis accepts an exact `redis@X.Y.Z` pin | No | (empty) |
| config-path | Path to pantry config file        | No       | `pantry.config.ts` |
| package-dir | Directory to publish from for monorepo packages | No | (empty) - repository root |

## Features

- 🚀 **Cross-platform support**: Works on Linux, macOS, and Windows runners
- 🔍 **Smart dependency detection**: Automatically detects project dependencies from package.json, requirements.txt, go.mod, and more
- 🔄 **Config file support**: Can extract package list from your pantry config file
- 🌐 **Context-aware**: Provides full GitHub context to commands
- 🔧 **Bun-powered**: Uses Bun for faster installation
- 📦 **Global flag support**: Handles global installation flags in dependency files
- 💬 **Comment-aware**: Properly parses YAML files with inline comments

### Health-checked Redis

Use the service input when tests need Redis. Pantry installs the exact requested
Redis package, binds it only to loopback, disables persistence for the ephemeral
runner, waits for `PONG`, exports `REDIS_URL` and `REDIS_SERVICE_VERSION`, and
stops the process after the job.

Daemon startup is bounded in two phases: the action first waits up to 10 seconds
for a live process ID, then up to 30 seconds for `redis-cli ping`. A startup
failure includes the Redis logfile in the Actions error so port collisions,
binary linkage failures, and invalid configuration are directly diagnosable.

```yaml
- name: Setup Pantry and Redis
  uses: pantry-pm/pantry/packages/action@main
  with:
    install: 'false'
    services: redis@8.8.0

- run: bun test
```

The action fails before tests when the installed version differs from the exact
service pin or Redis does not become ready. `redis-url` and `redis-version` are
also available as action outputs. Pin both the action revision and the Pantry
binary `version` in release-sensitive workflows so source and CLI behavior are
independently reproducible.

## Supported Dependency Files

The action automatically detects dependencies from these file types:

### Runtime Version Files

- `.nvmrc`, `.node-version` → Node.js
- `.ruby-version` → Ruby
- `.python-version` → Python
- `.terraform-version` → Terraform

### Package Manager Files

- `package.json` → Node.js (with engines, packageManager, volta support)
- `requirements.txt`, `pipfile`, `setup.py`, `pyproject.toml` → Python
- `Gemfile` → Ruby
- `Cargo.toml` → Rust
- `go.mod`, `go.sum` → Go
- `composer.json` → PHP
- `pom.xml`, `build.gradle` → Java

### Lock Files

- `yarn.lock`, `.yarnrc`, `.yarnrc.yml` → Yarn
- `bun.lock`, `bun.lockb` → Bun
- `pnpm-lock.yaml` → PNPM
- `uv.lock` → UV Python package manager

### Configuration Files

- `deno.json`, `deno.jsonc` → Deno
- `cdk.json` → AWS CDK
- `skaffold.yaml` → Kubernetes/Skaffold
- `justfile`, `Justfile` → Just task runner
- `Taskfile.yml` → Task runner
- `pixi.toml` → Pixi

### pantry/pkgx Dependency Files

- `dependencies.yaml`, `dependencies.yml`
- `deps.yaml`, `deps.yml`
- `pkgx.yaml`, `pkgx.yml`
- `pantry.yaml`, `pantry.yml`
- `.dependencies.yaml`, `.dependencies.yml`
- `.deps.yaml`, `.deps.yml`
- `.pkgx.yaml`, `.pkgx.yml`
- `.pantry.yaml`, `.pantry.yml`

### Global Flag Support

The action supports global installation flags in dependency files:

```yaml
# dependencies.yaml
global: true # Install all packages globally
dependencies:

  - node@22
  - python@3.12

# Override specific packages

  - typescript@5.0:

      version: 5.0.4
      global: false # Install locally

env:
  NODE_ENV: development
```

## Examples

### Basic Usage (Auto-detection)

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:

      - uses: actions/checkout@v4

      - name: Install Dependencies

        uses: pantry-pm/pantry-installer@v1
# Automatically detects Node.js from package.json
# and installs node + any other detected dependencies
```

### Using with Config File

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:

      - uses: actions/checkout@v4

      - name: Install Dependencies from Config

        uses: pantry-pm/pantry-installer@v1
# Will automatically detect packages from pantry.config.ts
```

### Multi-platform Workflow

```yaml
name: Multi-platform CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ${{ matrix.os }}
    strategy:
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
    steps:

      - uses: actions/checkout@v4

      - name: Install Dependencies

        uses: pantry-pm/pantry-installer@v1
# Auto-detects dependencies across all platforms
```

### Manual Package Override

```yaml
name: Manual Override

on:
  push:
    branches: [main]

jobs:
  setup:
    runs-on: ubuntu-latest
    steps:

      - uses: actions/checkout@v4

      - name: Install Specific Dependencies

        uses: pantry-pm/pantry-installer@v1
        with:
          packages: node python go rust
# Override auto-detection with specific packages

      - name: Run Tests

        run: npm test
```

### Commit Publishing (pkg-pr-new Replacement)

```yaml
name: Publish Commit Packages

on:
  pull_request:
    branches: [main]

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:

      - uses: actions/checkout@v4

      - name: Install Dependencies

        uses: pantry-pm/pantry-installer@v1

      - name: Publish Commit Packages

        run: pantry publish:commit './packages/_'
        env:
          PANTRY_TOKEN: ${{ secrets.PANTRY_TOKEN }}
# Replaces: bunx pkg-pr-new publish './packages/_'
# Each package gets an install URL tied to the commit SHA
```

### Custom Config Path

```yaml
name: Custom Config

on:
  push:
    branches: [main]

jobs:
  setup:
    runs-on: ubuntu-latest
    steps:

      - uses: actions/checkout@v4

      - name: Install Dependencies from Custom Config

        uses: pantry-pm/pantry-installer@v1
        with:
          config-path: .github/pantry.config.ts

      - name: Run Tests

        run: npm test
```

## Testing

```bash
bun test
```

## Changelog

Please see our [releases](https://github.com/pantry-pm/pantry-installer/releases) page for more information on what has changed recently.

## Contributing

Please see [CONTRIBUTING](https://github.com/pantry-pm/pantry/blob/main/.github/CONTRIBUTING.md) for details.

## Community

For help, discussion about best practices, or any other conversation that would benefit from being searchable:

[Discussions on GitHub](https://github.com/pantry-pm/pantry/discussions)

For casual chit-chat with others using this package:

[Join the Stacks Discord Server](https://discord.gg/stacksjs)

## Postcardware

"Software that is free, but hopes for a postcard." We love receiving postcards from around the world showing where Stacks is being used! We showcase them on our website too.

Our address: Stacks.js, 12665 Village Ln #2306, Playa Vista, CA 90094, United States 🌎

## Sponsors

We would like to extend our thanks to the following sponsors for funding Stacks development. If you are interested in becoming a sponsor, please reach out to us.

- [JetBrains](https://www.jetbrains.com/)
- [The Solana Foundation](https://solana.com/)

## License

The MIT License (MIT). Please see [LICENSE](https://github.com/pantry-pm/pantry/blob/main/LICENSE.md) for more information.

Made with 💙

<!-- Badges -->
[npm-version-src]: https://img.shields.io/npm/v/pantry-installer?style=flat-square
[npm-version-href]: https://npmjs.com/package/pantry-installer
[github-actions-src]: https://img.shields.io/github/actions/workflow/status/pantry-pm/pantry-installer/ci.yml?style=flat-square&branch=main
[github-actions-href]: https://github.com/pantry-pm/pantry-installer/actions?query=workflow%3Aci

<!-- [codecov-src]: https://img.shields.io/codecov/c/gh/pantry-pm/pantry-installer/main?style=flat-square
[codecov-href]: https://codecov.io/gh/pantry-pm/pantry-installer -->
