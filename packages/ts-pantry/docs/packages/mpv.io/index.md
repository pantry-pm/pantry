# mpv

> Media player based on MPlayer and mplayer2

## Package Information

- **Domain**: `mpv.io`
- **Name**: `mpv`
- **Homepage**: <https://mpv.io>
- **Source**: [View on GitHub](https://github.com/pkgxdev/pantry/tree/main/projects/mpv.io/package.yml)

## Installation

```bash
# Install with pantry
pantry install mpv.io
```

## Programs

This package provides the following executable programs:

- `mpv`

## Available Versions

<details>
<summary>Show all 50 versions</summary>

- `0.41.0`
- `0.40.0`
- `0.39.0`
- `0.38.0`
- `0.37.0`
- `0.36.0`
- `0.35.1`, `0.35.0`
- `0.34.1`, `0.34.0`
- `0.33.1`, `0.33.0`
- `0.32.0`
- `0.31.0`
- `0.30.0`
- `0.29.1`, `0.29.0`
- `0.28.2`, `0.28.1`, `0.28.0`
- `0.27.2`, `0.27.1`, `0.27.0`
- `0.26.0`
- `0.25.0`
- `0.24.0`
- `0.23.0`
- `0.22.0`
- `0.21.0`
- `0.20.0`
- `0.19.0`
- `0.18.1`, `0.18.0`
- `0.17.0`
- `0.16.0`
- `0.15.0`
- `0.14.0`
- `0.13.0`
- `0.12.0`
- `0.11.0`
- `0.10.0`
- `0.9.2`, `0.9.1`, `0.9.0`
- `0.8.3`, `0.8.2`, `0.8.1`, `0.8.0`
- `0.7.3`, `0.7.2`

</details>

**Latest Version**: `0.41.0`

### Install Specific Version

```bash
# Install a specific version
pantry install mpv.io@0.41.0
```

## Dependencies

This package depends on:

- `ffmpeg.org`
- `libjpeg-turbo.org@2`
- `libarchive.org@3`
- `github.com/libass/libass^0.17`
- `videolan.org/libplacebo@6`
- `littlecms.com@2`
- `luajit.org@2`
- `mujs.com@1`
- `freedesktop.org/uchardet@0`
- `vapoursynth.com@66`
- `yt-dlp.org`
- `linux:alsa-project.org/alsa-lib@1`
- `linux:github.com/adah1972/libunibreak@6`

## Usage Examples

```typescript
import { pantry } from 'ts-pantry'

// Access this package
const pkg = pantry.mpv

console.log(`Package: ${pkg.name}`)
console.log(`Description: ${pkg.description}`)
console.log(`Programs: ${pkg.programs.join(', ')}`)
```

## Links

- [Package Source](https://github.com/pkgxdev/pantry/tree/main/projects/mpv.io/package.yml)
- [Homepage](https://mpv.io)
- [Back to Package Catalog](../../package-catalog.md)

---

> Auto-generated from package data.
