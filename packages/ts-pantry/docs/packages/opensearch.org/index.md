# opensearch

> 🔎 Open source distributed and RESTful search engine.

## Package Information

- **Domain**: `opensearch.org`
- **Name**: `opensearch`
- **Homepage**: <https://opensearch.org/docs/latest/opensearch/index/>
- **Source**: [View on GitHub](https://github.com/pkgxdev/pantry/tree/main/projects/opensearch.org/package.yml)

## Installation

```bash
# Install with pantry
pantry install opensearch.org
```

## Programs

This package provides the following executable programs:

- `opensearch`
- `opensearch-keystore`
- `opensearch-plugin`
- `opensearch-shard`

## Available Versions

<details>
<summary>Show all 53 versions</summary>

- `3.7.0`
- `3.6.0`
- `3.5.0`
- `3.4.0`
- `3.3.2`, `3.3.1`, `3.3.0`
- `3.2.0`
- `3.1.0`
- `3.0.0`, `3.0.0-beta1`, `3.0.0-alpha1`
- `2.19.5`, `2.19.4`, `2.19.3`, `2.19.2`, `2.19.1`
- `2.18.0`
- `2.17.1`, `2.17.0`
- `2.16.0`
- `2.15.0`
- `2.14.0`
- `2.13.0`
- `2.12.0`
- `2.11.1`, `2.11.0`
- `2.10.0`
- `2.9.0`
- `2.8.0`
- `2.7.0`
- `2.6.0`
- `2.5.0`
- `2.4.1`, `2.4.0`
- `2.3.0`
- `2.2.1`, `2.2.0`
- `2.1.0`
- `2.0.1`
- `1.3.20`, `1.3.18`, `1.3.17`, `1.3.16`, `1.3.15`, `1.3.13`, `1.3.10`, `1.3.9`, `1.3.8`, `1.3.7`, `1.3.6`, `1.3.5`, `1.3.4`

</details>

**Latest Version**: `3.7.0`

### Install Specific Version

```bash
# Install specific version
sh <(curl https://pkgx.sh) +opensearch.org@3.7.0 -- $SHELL -i
```

## Dependencies

This package depends on:

- `openjdk.org^21 # since v3`
- `openmp.llvm.org^19`

## Usage Examples

```typescript
import { pantry } from 'ts-pkgx'

// Access this package
const pkg = pantry.opensearch

console.log(`Package: ${pkg.name}`)
console.log(`Description: ${pkg.description}`)
console.log(`Programs: ${pkg.programs.join(', ')}`)
```

## Links

- [Package Source](https://github.com/pkgxdev/pantry/tree/main/projects/opensearch.org/package.yml)
- [Homepage](https://opensearch.org/docs/latest/opensearch/index/)
- [Back to Package Catalog](../../package-catalog.md)

---

> Auto-generated from package data.
