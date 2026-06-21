# qpdf

> qpdf: A content-preserving PDF document transformer

## Package Information

- **Domain**: `qpdf.sourceforge.io`
- **Name**: `qpdf`
- **Homepage**: <https://qpdf.sourceforge.io/>
- **Source**: [View on GitHub](https://github.com/pkgxdev/pantry/tree/main/projects/qpdf.sourceforge.io/package.yml)

## Installation

```bash
# Install with pantry
pantry install qpdf.sourceforge.io
```

## Programs

This package provides the following executable programs:

- `qpdf`

## Available Versions

<details>
<summary>Show all 47 versions</summary>

- `12.3.2`, `12.3.1`, `12.3.0`
- `12.2.0`
- `12.1.0`
- `12.0.0`
- `11.10.1`, `11.10.0`
- `11.9.1`, `11.9.0`
- `11.8.0`
- `11.7.0`
- `11.6.4`, `11.6.3`, `11.6.2`, `11.6.1`
- `11.5.0`
- `11.4.0`
- `11.3.0`
- `11.2.0`
- `11.1.1`, `11.1.0`
- `11.0.0`
- `release-qpdf-10.6.3`, `release-qpdf-10.6.2`, `release-qpdf-10.6.1`, `release-qpdf-10.6.0`
- `release-qpdf-10.5.0`
- `release-qpdf-8.4.2`, `release-qpdf-8.4.1`, `release-qpdf-8.4.0`
- `release-qpdf-10.4.0`
- `release-qpdf-10.3.2`, `release-qpdf-10.3.1`, `release-qpdf-10.3.0`
- `release-qpdf-10.2.0`
- `release-qpdf-9.1.1`, `release-qpdf-9.1.0`
- `release-qpdf-10.1.0`
- `release-qpdf-10.0.4`, `release-qpdf-10.0.3`, `release-qpdf-10.0.2`, `release-qpdf-10.0.1`, `release-qpdf-10.0.0`
- `release-qpdf-9.0.2`, `release-qpdf-9.0.1`, `release-qpdf-9.0.0`

</details>

**Latest Version**: `12.3.2`

### Install Specific Version

```bash
# Install a specific version
pantry install qpdf.sourceforge.io@12.3.2
```

## Dependencies

This package depends on:

- `zlib.net^1`
- `libjpeg-turbo.org^2`
- `openssl.org^1.1`
- `gnutls.org^3`
- `linux:gnu.org/gcc/libstdcxx^14 # needs newer libstdc++ for C++20 support`

## Usage Examples

```typescript
import { pantry } from 'ts-pantry'

// Access this package
const pkg = pantry.qpdf

console.log(`Package: ${pkg.name}`)
console.log(`Description: ${pkg.description}`)
console.log(`Programs: ${pkg.programs.join(', ')}`)
```

## Links

- [Package Source](https://github.com/pkgxdev/pantry/tree/main/projects/qpdf.sourceforge.io/package.yml)
- [Homepage](https://qpdf.sourceforge.io/)
- [Back to Package Catalog](../../package-catalog.md)

---

> Auto-generated from package data.
