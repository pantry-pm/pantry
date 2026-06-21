# coredns

> CoreDNS is a DNS server that chains plugins

## Package Information

- **Domain**: `coredns.io`
- **Name**: `coredns`
- **Homepage**: <https://coredns.io/>
- **Source**: [View on GitHub](https://github.com/pkgxdev/pantry/tree/main/projects/coredns.io/package.yml)

## Installation

```bash
# Install with pantry
pantry install coredns.io
```

## Programs

This package provides the following executable programs:

- `coredns`

## Available Versions

<details>
<summary>Show all 53 versions</summary>

- `1.14.4`, `1.14.3`, `1.14.2`, `1.14.1`, `1.14.0`
- `1.13.2`, `1.13.1`, `1.13.0`
- `1.12.4`, `1.12.3`, `1.12.2`, `1.12.1`, `1.12.0`
- `1.11.4`, `1.11.3`, `1.11.2`, `1.11.1`, `1.11.0`
- `1.10.1`, `1.10.0`
- `1.9.4`, `1.9.3`, `1.9.2`, `1.9.1`, `1.9.0`
- `1.8.7`, `1.8.6`, `1.8.5`, `1.8.4`, `1.8.3`, `1.8.2`, `1.8.1`, `1.8.0`
- `1.7.1`, `1.7.0`
- `1.6.9`, `1.6.8`, `1.6.7`, `1.6.6`, `1.6.5`, `1.6.4`, `1.6.3`, `1.6.2`, `1.6.1`, `1.6.0`
- `1.5.2`, `1.5.1`, `1.5.0`
- `1.4.0`
- `1.3.1`, `1.3.0`
- `1.2.6`, `1.2.5`

</details>

**Latest Version**: `1.14.4`

### Install Specific Version

```bash
# Install specific version
sh <(curl https://pkgx.sh) +coredns.io@1.14.4 -- $SHELL -i
```

## Usage Examples

```typescript
import { pantry } from 'ts-pkgx'

// Access this package
const pkg = pantry.coredns

console.log(`Package: ${pkg.name}`)
console.log(`Description: ${pkg.description}`)
console.log(`Programs: ${pkg.programs.join(', ')}`)
```

## Links

- [Package Source](https://github.com/pkgxdev/pantry/tree/main/projects/coredns.io/package.yml)
- [Homepage](https://coredns.io/)
- [Back to Package Catalog](../../package-catalog.md)

---

> Auto-generated from package data.
