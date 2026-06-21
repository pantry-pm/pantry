# xslt

> Read-only mirror of <https://gitlab.gnome.org/GNOME/libxslt>

## Package Information

- **Domain**: `gnome.org/libxslt`
- **Name**: `xslt`
- **Homepage**: <http://xmlsoft.org/XSLT/>
- **Source**: [View on GitHub](https://github.com/pkgxdev/pantry/tree/main/projects/gnome.org/libxslt/package.yml)

## Installation

```bash
# Install with pantry
pantry install gnome.org/libxslt
```

## Programs

This package provides the following executable programs:

- `xslt-config`
- `xsltproc`

## Available Versions

<details>
<summary>Show all 33 versions</summary>

- `1.1.45`, `1.1.44`, `1.1.43`, `1.1.42`, `1.1.41`, `1.1.40`, `1.1.39`, `1.1.38`, `1.1.37`, `1.1.36`, `1.1.35`, `1.1.34`, `1.1.34-rc2`, `1.1.33`, `1.1.33-rc2`, `1.1.33-rc1`, `1.1.32`, `1.1.32-rc2`, `1.1.32-rc1`, `1.1.31`, `1.1.31-rc2`, `1.1.31-rc1`, `1.1.30`, `1.1.30-rc2`, `1.1.30-rc1`, `1.1.29`, `1.1.29-rc2`, `1.1.29-rc1`, `1.1.28`, `1.1.27`, `1.1.27-rc1`, `1.1.26`, `1.1.25`

</details>

**Latest Version**: `1.1.45`

### Install Specific Version

```bash
# Install a specific version
pantry install gnome.org/libxslt@1.1.45
```

## Dependencies

This package depends on:

- `gnome.org/libxml2`

## Usage Examples

```typescript
import { pantry } from 'ts-pantry'

// Access this package
const pkg = pantry.xslt

console.log(`Package: ${pkg.name}`)
console.log(`Description: ${pkg.description}`)
console.log(`Programs: ${pkg.programs.join(', ')}`)
```

## Links

- [Package Source](https://github.com/pkgxdev/pantry/tree/main/projects/gnome.org/libxslt/package.yml)
- [Homepage](http://xmlsoft.org/XSLT/)
- [Back to Package Catalog](../../../package-catalog.md)

---

> Auto-generated from package data.
