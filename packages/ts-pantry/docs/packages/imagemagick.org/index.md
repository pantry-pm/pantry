# imagemagick

> ImageMagick is a powerful, open-source software suite for creating, editing, converting, and manipulating images in over 200 formats. Ideal for web developers, graphic designers, and researchers, it offers versatile tools for image processing, including batch processing, format conversion, and complex image transformations.

## Package Information

- **Domain**: `imagemagick.org`
- **Name**: `imagemagick`
- **Homepage**: <https://imagemagick.org/index.php>
- **Source**: [View on GitHub](https://github.com/pkgxdev/pantry/tree/main/projects/imagemagick.org/package.yml)

## Installation

```bash
# Install with pantry
pantry install imagemagick.org
```

## Programs

This package provides the following executable programs:

- `animate`
- `compare`
- `composite`
- `conjure`
- `convert`
- `display`
- `identify`
- `import`
- `magick`
- `magick-script`
- `Magick++-config`
- `MagickCore-config`
- `MagickWand-config`
- `mogrify`
- `montage`
- `stream`

## Available Versions

<details>
<summary>Show all 62 versions</summary>

- `7.1.2.13`, `7.1.2-9`, `7.1.2-8`, `7.1.2-7`, `7.1.2-5`, `7.1.2-3`, `7.1.2-26`, `7.1.2-25`, `7.1.2-24`, `7.1.2-23`, `7.1.2-22`, `7.1.2-21`, `7.1.2-20`, `7.1.2-2`, `7.1.2-19`, `7.1.2-18`, `7.1.2-17`, `7.1.2-16`, `7.1.2-15`, `7.1.2-13`, `7.1.2-12`, `7.1.2-11`, `7.1.2-10`, `7.1.2-1`, `7.1.2-0`, `7.1.1.27`, `7.1.1.12`, `7.1.1-47`, `7.1.1-46`, `7.1.1-45`, `7.1.1-44`, `7.1.1-43`, `7.1.1-41`, `7.1.1-40`, `7.1.1-39`, `7.1.1-38`, `7.1.1-37`, `7.1.1-36`, `7.1.1-35`, `7.1.1-34`, `7.1.1-33`, `7.1.1-32`, `7.1.1-31`, `7.1.1-30`, `7.1.1-29`, `7.1.1-28`, `7.1.1-27`, `7.1.1-26`, `7.1.1-25`, `7.1.1-24`, `7.1.1-23`, `7.1.1-22`, `7.1.1-21`, `7.1.1-20`, `7.1.1-19`, `7.1.1-18`, `7.1.1-17`, `7.1.1-16`, `7.1.1-15`, `7.1.1-14`, `7.1.1-13`, `7.1.0.61`

</details>

**Latest Version**: `7.1.2.13`

### Install Specific Version

```bash
# Install specific version
sh <(curl https://pkgx.sh) +imagemagick.org@7.1.2.13 -- $SHELL -i
```

## Dependencies

This package depends on:

- `libpng.org`
- `ijg.org=8.4`
- `freetype.org`
- `libjpeg-turbo.org`
- `liblqr.wikidot.com`
- `simplesystems.org/libtiff`
- `gnu.org/libtool`
- `littlecms.com`
- `openexr.com`
- `openjpeg.org`
- `google.com/webp`
- `tukaani.org/xz`
- `sourceware.org/bzip2`
- `gnome.org/libxml2`
- `zlib.net^1`
- `jpeg.org/jpegxl`
- `perl.org`
- `libzip.org`
- `darwin:openmp.llvm.org`
- `darwin:github.com/strukturag/libheif`
- `linux:x.org/x11`

## Usage Examples

```typescript
import { pantry } from 'ts-pkgx'

// Access this package
const pkg = pantry.imagemagick

console.log(`Package: ${pkg.name}`)
console.log(`Description: ${pkg.description}`)
console.log(`Programs: ${pkg.programs.join(', ')}`)
```

## Links

- [Package Source](https://github.com/pkgxdev/pantry/tree/main/projects/imagemagick.org/package.yml)
- [Homepage](https://imagemagick.org/index.php)
- [Back to Package Catalog](../../package-catalog.md)

---

> Auto-generated from package data.
