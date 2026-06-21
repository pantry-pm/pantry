# webp

> Mirror only. Please do not send pull requests. See <https://chromium.googlesource.com/webm/libwebp/+/HEAD/CONTRIBUTING.md.>

## Package Information

- **Domain**: `google.com/webp`
- **Name**: `webp`
- **Homepage**: <https://developers.google.com/speed/webp/>
- **Source**: [View on GitHub](https://github.com/pkgxdev/pantry/tree/main/projects/google.com/webp/package.yml)

## Installation

```bash
# Install with pantry
pantry install google.com/webp
```

## Programs

This package provides the following executable programs:

- `cwebp`
- `dwebp`
- `gif2webp`
- `img2webp`
- `vwebp`
- `webpinfo`
- `webpmux`

## Available Versions

<details>
<summary>Show all 49 versions</summary>

- `1.6.0`, `1.6.0-rc1`
- `1.5.0`, `1.5.0-rc1`
- `1.4.0`, `1.4.0-rc1`
- `1.3.2`, `1.3.1`, `1.3.1-rc2`, `1.3.1-rc1`, `1.3.0`, `1.3.0-rc1`
- `1.2.4`, `1.2.3`, `1.2.3-rc1`, `1.2.2`, `1.2.2-rc2`, `1.2.2-rc1`, `1.2.1`, `1.2.1-rc2`, `1.2.0`, `1.2.0-rc3`
- `1.1.0`, `1.1.0-rc2`
- `1.0.3`, `1.0.3-rc1`, `1.0.2`, `1.0.2-rc1`, `1.0.1`, `1.0.1-rc2`, `1.0.0`, `1.0.0-rc3`, `1.0.0-rc2`, `1.0.0-rc1`
- `0.6.1`, `0.6.1-rc2`, `0.6.0`, `0.6.0-rc3`, `0.6.0-rc2`
- `0.5.2`, `0.5.2-rc2`, `0.5.1`, `0.5.1-rc5`, `0.5.0`, `0.5.0-rc1`
- `0.4.4`, `0.4.4-rc2`, `0.4.3`, `0.4.3-rc1`

</details>

**Latest Version**: `1.6.0`

### Install Specific Version

```bash
# Install a specific version
pantry install google.com/webp@1.6.0
```

## Dependencies

This package depends on:

- `giflib.sourceforge.io^5`
- `libjpeg-turbo.org^2`
- `libpng.org^1`
- `simplesystems.org/libtiff^4`

## Usage Examples

```typescript
import { pantry } from 'ts-pantry'

// Access this package
const pkg = pantry.webp

console.log(`Package: ${pkg.name}`)
console.log(`Description: ${pkg.description}`)
console.log(`Programs: ${pkg.programs.join(', ')}`)
```

## Links

- [Package Source](https://github.com/pkgxdev/pantry/tree/main/projects/google.com/webp/package.yml)
- [Homepage](https://developers.google.com/speed/webp/)
- [Back to Package Catalog](../../../package-catalog.md)

---

> Auto-generated from package data.
