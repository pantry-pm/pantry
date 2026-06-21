# htslib

> C library for high-throughput sequencing data formats

## Package Information

- **Domain**: `htslib.org`
- **Name**: `htslib`
- **Homepage**: <https://www.htslib.org/>
- **Source**: [View on GitHub](https://github.com/pkgxdev/pantry/tree/main/projects/htslib.org/package.yml)

## Installation

```bash
# Install with pantry
pantry install htslib.org
```

## Programs

This package provides the following executable programs:

- `bgzip`
- `htsfile`
- `tabix`

## Available Versions

<details>
<summary>Show all 39 versions</summary>

- `1.23.1`, `1.23`, `1.23.0`
- `1.22.2`, `1.22.1`, `1.22`, `1.22.0`
- `1.21.1`, `1.21`, `1.21.0`
- `1.20`, `1.20.0`
- `1.19.1`, `1.19`, `1.19.0`
- `1.18`, `1.18.0`
- `1.17`
- `1.16`
- `1.15.1`, `1.15`
- `1.14`
- `1.13`
- `1.12`
- `1.11`
- `1.10.2`, `1.10.1`, `1.10`
- `1.9`
- `1.8`
- `1.7`
- `1.6`
- `1.5`
- `1.4.1`, `1.4`
- `1.3.2`, `1.3.1`, `1.3`
- `1.2.1`

</details>

**Latest Version**: `1.23.1`

### Install Specific Version

```bash
# Install a specific version
pantry install htslib.org@1.23.1
```

## Dependencies

This package depends on:

- `sourceware.org/bzip2`
- `tukaani.org/xz`
- `zlib.net^1`
- `curl.se>=5`

## Usage Examples

```typescript
import { pantry } from 'ts-pantry'

// Access this package
const pkg = pantry.htslib

console.log(`Package: ${pkg.name}`)
console.log(`Description: ${pkg.description}`)
console.log(`Programs: ${pkg.programs.join(', ')}`)
```

## Links

- [Package Source](https://github.com/pkgxdev/pantry/tree/main/projects/htslib.org/package.yml)
- [Homepage](https://www.htslib.org/)
- [Back to Package Catalog](../../package-catalog.md)

---

> Auto-generated from package data.
