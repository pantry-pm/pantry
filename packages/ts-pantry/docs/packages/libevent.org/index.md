# libevent

> Event notification library

## Package Information

- **Domain**: `libevent.org`
- **Name**: `libevent`
- **Homepage**: <https://libevent.org>
- **Source**: [View on GitHub](https://github.com/pkgxdev/pantry/tree/main/projects/libevent.org/package.yml)

## Installation

```bash
# Install with pantry
pantry install libevent.org
```

## Programs

This package provides the following executable programs:

No programs specified.

## Available Versions

<details>
<summary>Show all 13 versions</summary>

- `2.1.12`, `2.1.11`, `2.1.10`, `2.1.8`, `2.1.6-beta`
- `2.0.22`, `2.0.21`, `2.0.20`, `2.0.19`, `2.0.18`, `2.0.17`, `2.0.16`
- `1.4.15`

</details>

**Latest Version**: `2.1.12`

### Install Specific Version

```bash
# Install specific version
sh <(curl https://pkgx.sh) +libevent.org@2.1.12 -- $SHELL -i
```

## Dependencies

This package depends on:

- `openssl.org^1.1`

## Usage Examples

```typescript
import { pantry } from 'ts-pkgx'

// Access this package
const pkg = pantry.libevent

console.log(`Package: ${pkg.name}`)
console.log(`Description: ${pkg.description}`)
console.log(`Programs: ${pkg.programs.join(', ')}`)
```

## Links

- [Package Source](https://github.com/pkgxdev/pantry/tree/main/projects/libevent.org/package.yml)
- [Homepage](https://libevent.org)
- [Back to Package Catalog](../../package-catalog.md)

---

> Auto-generated from package data.
