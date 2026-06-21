# pcre2

> Perl compatible regular expressions library with a new API

## Package Information

- **Domain**: `pcre.org/v2`
- **Name**: `pcre2`
- **Homepage**: <https://www.pcre.org/>
- **Source**: [View on GitHub](https://github.com/pkgxdev/pantry/tree/main/projects/pcre.org/v2/package.yml)

## Installation

```bash
# Install with pantry
pantry install pcre.org/v2
```

## Programs

This package provides the following executable programs:

- `pcre2-config`
- `pcre2grep`
- `pcre2test`

## Available Versions

<details>
<summary>Show all 32 versions</summary>

- `10.47`, `10.47.0`
- `10.46`, `10.46.0`
- `10.45`
- `10.45-RC1`
- `10.44`, `10.44.0`
- `10.43`, `10.43.0`
- `10.43-RC1`
- `10.42`, `10.42.0`
- `10.41`
- `10.40`
- `10.39`
- `10.38`
- `10.38-RC1`
- `10.37`
- `10.36`
- `10.35`
- `10.34`
- `10.33`
- `10.32`
- `10.31`
- `10.30`
- `10.23`
- `10.22`
- `10.21`
- `10.20`
- `10.10`
- `10.00`

</details>

**Latest Version**: `10.47`

### Install Specific Version

```bash
# Install specific version
sh <(curl https://pkgx.sh) +pcre.org/v2@10.47 -- $SHELL -i
```

## Dependencies

This package depends on:

- `sourceware.org/bzip2@1`
- `zlib.net@1`

## Usage Examples

```typescript
import { pantry } from 'ts-pkgx'

// Access this package
const pkg = pantry.pcre2

console.log(`Package: ${pkg.name}`)
console.log(`Description: ${pkg.description}`)
console.log(`Programs: ${pkg.programs.join(', ')}`)
```

## Links

- [Package Source](https://github.com/pkgxdev/pantry/tree/main/projects/pcre.org/v2/package.yml)
- [Homepage](https://www.pcre.org/)
- [Back to Package Catalog](../../../package-catalog.md)

---

> Auto-generated from package data.
