# mkcert

> A simple zero-config tool to make locally trusted development certificates with any names you'd like.

## Package Information

- **Domain**: `mkcert.dev`
- **Name**: `mkcert`
- **Homepage**: <https://mkcert.dev>
- **Source**: [View on GitHub](https://github.com/pkgxdev/pantry/tree/main/projects/mkcert.dev/package.yml)

## Installation

```bash
# Install with pantry
pantry install mkcert.dev
```

## Programs

This package provides the following executable programs:

- `mkcert`

## Available Versions

<details>
<summary>Show all 14 versions</summary>

- `1.4.4`, `1.4.3`, `1.4.2`, `1.4.1`, `1.4.0`
- `1.3.0`
- `1.2.0`
- `1.1.2`, `1.1.1`, `1.1.0`
- `1.0.1`, `1.0.0`
- `0.9.1`, `0.9.0`

</details>

**Latest Version**: `1.4.4`

### Install Specific Version

```bash
# Install a specific version
pantry install mkcert.dev@1.4.4
```

## Usage Examples

```typescript
import { pantry } from 'ts-pantry'

// Access this package
const pkg = pantry.mkcert

console.log(`Package: ${pkg.name}`)
console.log(`Description: ${pkg.description}`)
console.log(`Programs: ${pkg.programs.join(', ')}`)
```

## Links

- [Package Source](https://github.com/pkgxdev/pantry/tree/main/projects/mkcert.dev/package.yml)
- [Homepage](https://mkcert.dev)
- [Back to Package Catalog](../../package-catalog.md)

---

> Auto-generated from package data.
