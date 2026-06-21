# exr

> The OpenEXR project provides the specification and reference implementation of the EXR file format, the professional-grade image storage format of the motion picture industry.

## Package Information

- **Domain**: `openexr.com`
- **Name**: `exr`
- **Homepage**: <https://www.openexr.com/>
- **Source**: [View on GitHub](https://github.com/pkgxdev/pantry/tree/main/projects/openexr.com/package.yml)

## Installation

```bash
# Install with pantry
pantry install openexr.com
```

## Programs

This package provides the following executable programs:

- `exr2aces`
- `exrenvmap`
- `exrheader`
- `exrmakepreview`
- `exrmaketiled`
- `exrmultipart`
- `exrmultiview`
- `exrstdattr`

## Available Versions

<details>
<summary>Show all 95 versions</summary>

- `3.4.13`, `3.4.13-rc3`, `3.4.13-rc2`, `3.4.13-rc`, `3.4.12`, `3.4.12-rc2`, `3.4.11`, `3.4.11-rc3`, `3.4.11-rc2`, `3.4.11-rc`, `3.4.10`, `3.4.10-rc`, `3.4.9`, `3.4.9-rc`, `3.4.8`, `3.4.8-rc`, `3.4.7`, `3.4.7-rc`, `3.4.6`, `3.4.6-rc`, `3.4.5`, `3.4.5-rc`, `3.4.4`, `3.4.4-rc2`, `3.4.4-rc`, `3.4.3`, `3.4.3-rc3`, `3.4.3-rc2`, `3.4.3-rc`, `3.4.2`, `3.4.2-rc2`, `3.4.2-rc`, `3.4.1`, `3.4.1-rc2`, `3.4.1-rc`, `3.4.0`, `3.4.0-rc2`, `3.4.0-rc`
- `3.4-alpha`
- `3.3.12-rc`, `3.3.11`, `3.3.11-rc3`, `3.3.11-rc2`, `3.3.11-rc`, `3.3.10`, `3.3.10-rc2`, `3.3.10-rc`, `3.3.9`, `3.3.9-rc2`, `3.3.9-rc`, `3.3.8`, `3.3.8-rc`, `3.3.7`, `3.3.7-rc4`, `3.3.7-rc3`, `3.3.6`, `3.3.5`, `3.3.4`, `3.3.3`, `3.3.2`, `3.3.1`, `3.3.0`
- `3.2.126`, `3.2.9`, `3.2.8`, `3.2.7`, `3.2.6`, `3.2.5`, `3.2.4`, `3.2.3`, `3.2.2`, `3.2.1`, `3.2.0`
- `3.1.13`, `3.1.12`, `3.1.11`, `3.1.10`, `3.1.9`, `3.1.8`, `3.1.7`, `3.1.6`, `3.1.5`, `3.1.4`, `3.1.3`, `3.1.2`, `3.1.1`, `3.1.0`
- `3.0.5`, `3.0.4`, `3.0.3`, `3.0.2`
- `2.5.10`, `2.5.9`, `2.5.8`, `2.5.7`

</details>

**Latest Version**: `3.4.13`

### Install Specific Version

```bash
# Install a specific version
pantry install openexr.com@3.4.13
```

## Dependencies

This package depends on:

- `zlib.net^1`
- `openexr.com/imath`
- `linux:gnu.org/gcc/libstdcxx^14 # needed since 3.4.0`

## Usage Examples

```typescript
import { pantry } from 'ts-pantry'

// Access this package
const pkg = pantry.exr

console.log(`Package: ${pkg.name}`)
console.log(`Description: ${pkg.description}`)
console.log(`Programs: ${pkg.programs.join(', ')}`)
```

## Links

- [Package Source](https://github.com/pkgxdev/pantry/tree/main/projects/openexr.com/package.yml)
- [Homepage](https://www.openexr.com/)
- [Back to Package Catalog](../../package-catalog.md)

---

> Auto-generated from package data.
