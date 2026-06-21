# opendap

> A new version of libdap that contains both DAP2 and DAP4 support

## Package Information

- **Domain**: `opendap.org`
- **Name**: `opendap`
- **Homepage**: <https://www.opendap.org/>
- **Source**: [View on GitHub](https://github.com/pkgxdev/pantry/tree/main/projects/opendap.org/package.yml)

## Installation

```bash
# Install with pantry
pantry install opendap.org
```

## Programs

This package provides the following executable programs:

- `dap-config`
- `dap-config-pkgconfig`
- `getdap`
- `getdap4`

## Available Versions

<details>
<summary>Show all 20 versions</summary>

- `3.21.1`
- `3.20.11`
- `ersion-3.20.6`, `ersion-3.20.5`, `ersion-3.20.4`, `ersion-3.20.3`, `ersion-3.20.2`, `ersion-3.20.1`, `ersion-3.20.0`
- `ersion-3.19.1`, `ersion-3.19.0`
- `ersion-3.18.3`, `ersion-3.18.2`, `ersion-3.18.1`, `ersion-3.18.0`
- `ersion-3.17.3`, `ersion-3.17.1`, `ersion-3.17.0`
- `ersion-3.16.0`
- `ersion-3.15.1`

</details>

**Latest Version**: `3.21.1`

### Install Specific Version

```bash
# Install a specific version
pantry install opendap.org@3.21.1
```

## Dependencies

This package depends on:

- `gnome.org/libxml2`
- `openssl.org`
- `curl.se`
- `linux:sourceforge.net/libtirpc`
- `linux:github.com/util-linux/util-linux`

## Usage Examples

```typescript
import { pantry } from 'ts-pantry'

// Access this package
const pkg = pantry.opendap

console.log(`Package: ${pkg.name}`)
console.log(`Description: ${pkg.description}`)
console.log(`Programs: ${pkg.programs.join(', ')}`)
```

## Links

- [Package Source](https://github.com/pkgxdev/pantry/tree/main/projects/opendap.org/package.yml)
- [Homepage](https://www.opendap.org/)
- [Back to Package Catalog](../../package-catalog.md)

---

> Auto-generated from package data.
