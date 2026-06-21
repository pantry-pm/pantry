# mosh

> Remote terminal application

## Package Information

- **Domain**: `mosh.org`
- **Name**: `mosh`
- **Homepage**: <https://mosh.org>
- **Source**: [View on GitHub](https://github.com/pkgxdev/pantry/tree/main/projects/mosh.org/package.yml)

## Installation

```bash
# Install with pantry
pantry install mosh.org
```

## Programs

This package provides the following executable programs:

- `mosh-client`
- `mosh-server`

## Available Versions

<details>
<summary>Show all 6 versions</summary>

- `1.4.0`
- `1.3.2`, `1.3.0`
- `1.2.6`, `1.2.5`, `1.2.4`

</details>

**Latest Version**: `1.4.0`

### Install Specific Version

```bash
# Install a specific version
pantry install mosh.org@1.4.0
```

## Dependencies

This package depends on:

- `protobuf.dev@26.1.0`
- `invisible-island.net/ncurses@6`
- `zlib.net@1.3`
- `linux:openssl.org@3`

## Usage Examples

```typescript
import { pantry } from 'ts-pantry'

// Access this package
const pkg = pantry.mosh

console.log(`Package: ${pkg.name}`)
console.log(`Description: ${pkg.description}`)
console.log(`Programs: ${pkg.programs.join(', ')}`)
```

## Links

- [Package Source](https://github.com/pkgxdev/pantry/tree/main/projects/mosh.org/package.yml)
- [Homepage](https://mosh.org)
- [Back to Package Catalog](../../package-catalog.md)

---

> Auto-generated from package data.
