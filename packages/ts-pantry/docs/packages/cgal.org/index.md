# cgal

> The public CGAL repository, see the README below

## Package Information

- **Domain**: `cgal.org`
- **Name**: `cgal`
- **Homepage**: <https://github.com/CGAL/cgal#readme>
- **Source**: [View on GitHub](https://github.com/pkgxdev/pantry/tree/main/projects/cgal.org/package.yml)

## Installation

```bash
# Install with pantry
pantry install cgal.org
```

## Programs

This package provides the following executable programs:

- `cgal_create_CMakeLists`
- `cgal_create_cmake_script`
- `cgal_make_macosx_app`

## Available Versions

<details>
<summary>Show all 45 versions</summary>

- `6.2`
- `6.1.2`, `6.1.1`, `6.1`, `6.1.0`
- `6.0.3`, `6.0.2`, `6.0.1`, `6.0`, `6.0.0`
- `5.6.3`, `5.6.2`, `5.6.1`, `5.6`, `5.6.0`
- `5.5.5`, `5.5.4`, `5.5.3`, `5.5.2`, `5.5.1`, `5.5`
- `5.4.5`, `5.4.4`, `5.4.3`, `5.4.2`, `5.4.1`, `5.4`
- `5.3.2`, `5.3.1`, `5.3`
- `5.2.4`, `5.2.3`, `5.2.2`, `5.2.1`, `5.2`
- `5.1.5`, `5.1.4`, `5.1.3`, `5.1.2`, `5.1.1`, `5.1`
- `5.0.4`
- `releases/CGAL-5.0.3`, `releases/CGAL-5.0.2`
- `releases/CGAL-4.14.3`

</details>

**Latest Version**: `6.2`

### Install Specific Version

```bash
# Install specific version
sh <(curl https://pkgx.sh) +cgal.org@6.2 -- $SHELL -i
```

## Dependencies

This package depends on:

- `boost.org`
- `eigen.tuxfamily.org`
- `gnu.org/gmp`
- `gnu.org/mpfr`
- `openssl.org`

## Usage Examples

```typescript
import { pantry } from 'ts-pkgx'

// Access this package
const pkg = pantry.cgal

console.log(`Package: ${pkg.name}`)
console.log(`Description: ${pkg.description}`)
console.log(`Programs: ${pkg.programs.join(', ')}`)
```

## Links

- [Package Source](https://github.com/pkgxdev/pantry/tree/main/projects/cgal.org/package.yml)
- [Homepage](https://github.com/CGAL/cgal#readme)
- [Back to Package Catalog](../../package-catalog.md)

---

> Auto-generated from package data.
