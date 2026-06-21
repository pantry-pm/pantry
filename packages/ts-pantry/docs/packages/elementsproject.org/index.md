# elementsproject

> Open Source implementation of advanced blockchain features extending the Bitcoin protocol

## Package Information

- **Domain**: `elementsproject.org`
- **Name**: `elementsproject`
- **Homepage**: Not specified
- **Source**: [View on GitHub](https://github.com/pkgxdev/pantry/tree/main/projects/elementsproject.org/package.yml)

## Installation

```bash
# Install with pantry
pantry install elementsproject.org
```

## Programs

This package provides the following executable programs:

- `bench_bitcoin`
- `elements-cli`
- `elements-tx`
- `elements-util`
- `elements-wallet`
- `elementsd`
- `test_bitcoin`

## Available Versions

<details>
<summary>Show all 33 versions</summary>

- `23.3.3`, `23.3.2`, `23.3.1`, `23.3.0`
- `23.2.7`, `23.2.6`, `23.2.5`, `23.2.4`, `23.2.3`, `23.2.2`, `23.2.1`
- `22.1.1`, `22.1`
- `22.0.2`
- `0.21.0.3`, `0.21.0.2`, `0.21.0.1`, `0.21.0`
- `0.18.1.12`, `0.18.1.11`, `0.18.1.9`, `0.18.1.8`, `0.18.1.7`, `0.18.1.6`, `0.18.1.5`, `0.18.1.4`, `0.18.1.3`, `0.18.1.2`, `0.18.1.1`
- `0.17.0.3`, `0.17.0.2`, `0.17.0.1`, `0.17.0`

</details>

**Latest Version**: `23.3.3`

### Install Specific Version

```bash
# Install specific version
sh <(curl https://pkgx.sh) +elementsproject.org@23.3.3 -- $SHELL -i
```

## Dependencies

This package depends on:

- `boost.org^1.64`
- `libevent.org`
- `oracle.com/berkeley-db`

## Usage Examples

```typescript
import { pantry } from 'ts-pkgx'

// Access this package
const pkg = pantry.elementsproject

console.log(`Package: ${pkg.name}`)
console.log(`Description: ${pkg.description}`)
console.log(`Programs: ${pkg.programs.join(', ')}`)
```

## Links

- [Package Source](https://github.com/pkgxdev/pantry/tree/main/projects/elementsproject.org/package.yml)
- [Homepage](#)
- [Back to Package Catalog](../../package-catalog.md)

---

> Auto-generated from package data.
