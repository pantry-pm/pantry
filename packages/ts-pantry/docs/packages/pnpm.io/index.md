# pnp

> Fast, disk space efficient package manager

## Package Information

- **Domain**: `pnpm.io`
- **Name**: `pnp`
- **Homepage**: <https://pnpm.io/>
- **Source**: [View on GitHub](https://github.com/pkgxdev/pantry/tree/main/projects/pnpm.io/package.yml)

## Installation

```bash
# Install with pantry
pantry install pnpm.io
```

## Programs

This package provides the following executable programs:

- `pnpm`
- `pnpx`

## Available Versions

<details>
<summary>Show all 70 versions</summary>

- `11.8.0`
- `11.7.0`
- `11.6.0`
- `11.5.3`, `11.5.2`, `11.5.1`, `11.5.0`
- `11.4.0`
- `11.3.0`
- `11.2.2`, `11.2.1`, `11.2.0`
- `11.1.3`, `11.1.2`, `11.1.1`, `11.1.0`
- `11.0.9`, `11.0.8`, `11.0.7`, `11.0.6`, `11.0.5`, `11.0.4`, `11.0.3`, `11.0.2`, `11.0.1`, `11.0.0`
- `10.34.4`, `10.34.3`, `10.34.2`, `10.34.1`, `10.34.0`
- `10.33.4`, `10.33.3`, `10.33.2`, `10.33.1`, `10.33.0`
- `10.32.1`, `10.32.0`
- `10.31.0`
- `10.30.3`, `10.30.2`, `10.30.1`, `10.30.0`
- `10.29.3`, `10.29.2`, `10.29.1`
- `10.28.2`, `10.28.1`, `10.28.0`
- `10.27.0`
- `10.26.2`, `10.26.1`, `10.26.0`
- `10.25.0`
- `10.24.0`
- `10.23.0`
- `10.22.0`
- `10.21.0`
- `10.20.0`
- `10.19.0`
- `10.18.3`, `10.18.2`, `10.18.1`, `10.18.0`
- `10.17.1`, `10.17.0`
- `10.16.1`, `10.16.0`
- `10.15.1`, `10.15.0`

</details>

**Latest Version**: `11.8.0`

### Install Specific Version

```bash
# Install specific version
sh <(curl https://pkgx.sh) +pnpm.io@11.8.0 -- $SHELL -i
```

## Dependencies

This package depends on:

- `nodejs.org`

## Usage Examples

```typescript
import { pantry } from 'ts-pkgx'

// Access this package
const pkg = pantry.pnp

console.log(`Package: ${pkg.name}`)
console.log(`Description: ${pkg.description}`)
console.log(`Programs: ${pkg.programs.join(', ')}`)
```

## Links

- [Package Source](https://github.com/pkgxdev/pantry/tree/main/projects/pnpm.io/package.yml)
- [Homepage](https://pnpm.io/)
- [Back to Package Catalog](../../package-catalog.md)

---

> Auto-generated from package data.
