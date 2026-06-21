# teller

> Cloud native secrets management for developers - never leave your command line for secrets.

## Package Information

- **Domain**: `tlr.dev`
- **Name**: `teller`
- **Homepage**: Not specified
- **Source**: [View on GitHub](https://github.com/pkgxdev/pantry/tree/main/projects/tlr.dev/package.yml)

## Installation

```bash
# Install with pantry
pantry install tlr.dev
```

## Programs

This package provides the following executable programs:

- `teller`

## Available Versions

<details>
<summary>Show all 19 versions</summary>

- `2.0.7`, `2.0.6`, `2.0.5`, `2.0.4`, `2.0.3`
- `1.5.6`, `1.5.5`, `1.5.4`, `1.5.3`, `1.5.2`, `1.5.1`, `1.5.0`
- `1.4.0`
- `1.3.0`
- `1.2.0`
- `1.1.0`
- `1.0.0`
- `0.6.0`
- `0.5.0`

</details>

**Latest Version**: `2.0.7`

### Install Specific Version

```bash
# Install a specific version
pantry install tlr.dev@2.0.7
```

## Dependencies

This package depends on:

- `openssl.org^1.1`

## Usage Examples

```typescript
import { pantry } from 'ts-pantry'

// Access this package
const pkg = pantry.teller

console.log(`Package: ${pkg.name}`)
console.log(`Description: ${pkg.description}`)
console.log(`Programs: ${pkg.programs.join(', ')}`)
```

## Links

- [Package Source](https://github.com/pkgxdev/pantry/tree/main/projects/tlr.dev/package.yml)
- [Homepage](#)
- [Back to Package Catalog](../../package-catalog.md)

---

> Auto-generated from package data.
