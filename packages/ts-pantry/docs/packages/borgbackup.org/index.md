# borg

> Deduplicating archiver with compression and authenticated encryption.

## Package Information

- **Domain**: `borgbackup.org`
- **Name**: `borg`
- **Homepage**: <https://www.borgbackup.org/>
- **Source**: [View on GitHub](https://github.com/pkgxdev/pantry/tree/main/projects/borgbackup.org/package.yml)

## Installation

```bash
# Install with pantry
pantry install borgbackup.org
```

## Programs

This package provides the following executable programs:

- `borg`
- `borgfs`

## Available Versions

<details>
<summary>Show all 18 versions</summary>

- `1.4.4`, `1.4.3`, `1.4.2`, `1.4.1`, `1.4.0`
- `1.2.9`, `1.2.8`, `1.2.7`, `1.2.6`, `1.2.5`, `1.2.4`, `1.2.3`, `1.2.2`, `1.2.1`, `1.2.0`
- `1.1.18`, `1.1.17`, `1.1.16`

</details>

**Latest Version**: `1.4.4`

### Install Specific Version

```bash
# Install specific version
sh <(curl https://pkgx.sh) +borgbackup.org@1.4.4 -- $SHELL -i
```

## Dependencies

This package depends on:

- `pkgx.sh>=1`
- `github.com/Cyan4973/xxHash^0.8`

## Usage Examples

```typescript
import { pantry } from 'ts-pkgx'

// Access this package
const pkg = pantry.borg

console.log(`Package: ${pkg.name}`)
console.log(`Description: ${pkg.description}`)
console.log(`Programs: ${pkg.programs.join(', ')}`)
```

## Links

- [Package Source](https://github.com/pkgxdev/pantry/tree/main/projects/borgbackup.org/package.yml)
- [Homepage](https://www.borgbackup.org/)
- [Back to Package Catalog](../../package-catalog.md)

---

> Auto-generated from package data.
