# taplo

> A TOML toolkit written in Rust

## Package Information

- **Domain**: `taplo.tamasfe.dev`
- **Name**: `taplo`
- **Homepage**: <https://taplo.tamasfe.dev>
- **Source**: [View on GitHub](https://github.com/pkgxdev/pantry/tree/main/projects/taplo.tamasfe.dev/package.yml)

## Installation

```bash
# Install with pantry
pantry install taplo.tamasfe.dev
```

## Programs

This package provides the following executable programs:

- `taplo`

## Available Versions

<details>
<summary>Show all 20 versions</summary>

- `release-taplo-0.13.0`
- `0.10.0`
- `0.9.3`, `0.9.2`
- `release-taplo-cli-0.9.0`
- `0.8.1`, `0.8.0`
- `0.7.2`
- `release-taplo-cli-0.7.0`
- `release-taplo-cli-0.6.8`, `release-taplo-cli-0.6.7`
- `release-cli-0.6.3`, `release-cli-0.6.2`, `release-cli-0.6.1`, `release-cli-0.6.0`
- `release-cli-0.5.0`
- `release-cli-0.4.1`
- `release-lsp-0.2.6`, `release-lsp-0.2.5`
- `release-taplo__core-0.2.0`

</details>

**Latest Version**: `release-taplo-0.13.0`

### Install Specific Version

```bash
# Install specific version
sh <(curl https://pkgx.sh) +taplo.tamasfe.dev@release-taplo-0.13.0 -- $SHELL -i
```

## Usage Examples

```typescript
import { pantry } from 'ts-pkgx'

// Access this package
const pkg = pantry.taplo

console.log(`Package: ${pkg.name}`)
console.log(`Description: ${pkg.description}`)
console.log(`Programs: ${pkg.programs.join(', ')}`)
```

## Links

- [Package Source](https://github.com/pkgxdev/pantry/tree/main/projects/taplo.tamasfe.dev/package.yml)
- [Homepage](https://taplo.tamasfe.dev)
- [Back to Package Catalog](../../package-catalog.md)

---

> Auto-generated from package data.
