# chomp

> 'JS Make' - parallel task runner for the frontend ecosystem with a JS extension system.

## Package Information

- **Domain**: `chompbuild.com`
- **Name**: `chomp`
- **Homepage**: <https://chompbuild.com>
- **Source**: [View on GitHub](https://github.com/pkgxdev/pantry/tree/main/projects/chompbuild.com/package.yml)

## Installation

```bash
# Install with pantry
pantry install chompbuild.com
```

## Programs

This package provides the following executable programs:

- `chomp`

## Available Versions

<details>
<summary>Show all 41 versions</summary>

- `0.3.0`
- `0.2.23`, `0.2.22`, `0.2.21`, `0.2.20`, `0.2.19`, `0.2.18`, `0.2.17`, `0.2.16`, `0.2.15`, `0.2.14`, `0.2.13`, `0.2.12`, `0.2.11`, `0.2.10`, `0.2.9`, `0.2.8`, `0.2.7`, `0.2.6`, `0.2.5`, `0.2.4`, `0.2.3`, `0.2.2`, `0.2.1`, `0.2.0`
- `0.1.15`, `0.1.14`, `0.1.13`, `0.1.12`, `0.1.11`, `0.1.10`, `0.1.9`, `0.1.8`, `0.1.7`, `0.1.6`, `0.1.5`, `0.1.4`, `0.1.3`, `0.1.2`, `0.1.1`, `0.1.0`

</details>

**Latest Version**: `0.3.0`

### Install Specific Version

```bash
# Install specific version
sh <(curl https://pkgx.sh) +chompbuild.com@0.3.0 -- $SHELL -i
```

## Dependencies

This package depends on:

- `openssl.org^1.1`

## Usage Examples

```typescript
import { pantry } from 'ts-pkgx'

// Access this package
const pkg = pantry.chomp

console.log(`Package: ${pkg.name}`)
console.log(`Description: ${pkg.description}`)
console.log(`Programs: ${pkg.programs.join(', ')}`)
```

## Links

- [Package Source](https://github.com/pkgxdev/pantry/tree/main/projects/chompbuild.com/package.yml)
- [Homepage](https://chompbuild.com)
- [Back to Package Catalog](../../package-catalog.md)

---

> Auto-generated from package data.
