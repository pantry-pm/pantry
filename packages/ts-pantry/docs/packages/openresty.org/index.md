# openresty

> High Performance Web Platform Based on Nginx and LuaJIT

## Package Information

- **Domain**: `openresty.org`
- **Name**: `openresty`
- **Homepage**: <https://openresty.org>
- **Source**: [View on GitHub](https://github.com/pkgxdev/pantry/tree/main/projects/openresty.org/package.yml)

## Installation

```bash
# Install with pantry
pantry install openresty.org
```

## Programs

This package provides the following executable programs:

- `nginx-xml2pod`
- `opm`
- `resty`
- `restydoc`
- `restydoc-index`

## Available Versions

<details>
<summary>Show all 16 versions</summary>

- `1.27.1.2`, `1.27.1.1`
- `1.25.3.2`, `1.25.3.1`
- `1.21.4.3`, `1.21.4.2`
- `1.15.8.3`, `1.15.8.2`, `1.15.8.1`
- `1.13.6.2`, `1.13.6.1`
- `1.11.2.5`, `1.11.2.3`, `1.11.2.2`, `1.11.2.1`
- `1.9.15.1`

</details>

**Latest Version**: `1.27.1.2`

### Install Specific Version

```bash
# Install specific version
sh <(curl https://pkgx.sh) +openresty.org@1.27.1.2 -- $SHELL -i
```

## Dependencies

This package depends on:

- `pcre.org@8`
- `openssl.org^1.1`
- `zlib.net^1.2`
- `perl.org`

## Usage Examples

```typescript
import { pantry } from 'ts-pkgx'

// Access this package
const pkg = pantry.openresty

console.log(`Package: ${pkg.name}`)
console.log(`Description: ${pkg.description}`)
console.log(`Programs: ${pkg.programs.join(', ')}`)
```

## Links

- [Package Source](https://github.com/pkgxdev/pantry/tree/main/projects/openresty.org/package.yml)
- [Homepage](https://openresty.org)
- [Back to Package Catalog](../../package-catalog.md)

---

> Auto-generated from package data.
