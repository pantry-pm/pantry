# solr

> Apache Solr enterprise search platform

## Package Information

- **Domain**: `solr.apache.org`
- **Name**: `solr`
- **Homepage**: <https://solr.apache.org>
- **Source**: [View on GitHub](https://github.com/pkgxdev/pantry/tree/main/projects/solr.apache.org/package.yml)

## Installation

```bash
# Install with pantry
pantry install solr.apache.org
```

## Programs

This package provides the following executable programs:

- `solr`

## Available Versions

<details>
<summary>Show all 22 versions</summary>

- `10.0.0`
- `9.10.1`, `9.10.0`
- `9.9.0`
- `9.8.1`, `9.8.0`
- `9.7.0`
- `9.6.1`, `9.6.0`
- `9.5.0`
- `9.4.1`, `9.4.0`
- `9.3.0`
- `9.2.1`, `9.2.0`
- `9.1.1`, `9.1.0`
- `9.0.0`
- `1.4.0`
- `1.3.0`
- `1.2.0`
- `1.1.0`

</details>

**Latest Version**: `10.0.0`

### Install Specific Version

```bash
# Install specific version
sh <(curl https://pkgx.sh) +solr.apache.org@10.0.0 -- $SHELL -i
```

## Dependencies

This package depends on:

- `openjdk.org`

## Usage Examples

```typescript
import { pantry } from 'ts-pkgx'

// Access this package
const pkg = pantry.solr

console.log(`Package: ${pkg.name}`)
console.log(`Description: ${pkg.description}`)
console.log(`Programs: ${pkg.programs.join(', ')}`)
```

## Links

- [Package Source](https://github.com/pkgxdev/pantry/tree/main/projects/solr.apache.org/package.yml)
- [Homepage](https://solr.apache.org)
- [Back to Package Catalog](../../package-catalog.md)

---

> Auto-generated from package data.
