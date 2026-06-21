# gdal

> GDAL is an open source MIT licensed translator library for raster and vector geospatial data formats.

## Package Information

- **Domain**: `gdal.org`
- **Name**: `gdal`
- **Homepage**: <https://www.gdal.org/>
- **Source**: [View on GitHub](https://github.com/pkgxdev/pantry/tree/main/projects/gdal.org/package.yml)

## Installation

```bash
# Install with pantry
pantry install gdal.org
```

## Programs

This package provides the following executable programs:

- `gdaladdo`
- `gdalbuildvrt`
- `gdal-config`
- `gdal_contour`
- `gdal_create`
- `gdaldem`
- `gdalenhance`
- `gdal_grid`
- `gdalinfo`
- `gdallocationinfo`
- `gdalmanage`
- `gdalmdiminfo`
- `gdalmdimtranslate`
- `gdal_rasterize`
- `gdalsrsinfo`
- `gdaltindex`
- `gdaltransform`
- `gdal_translate`
- `gdal_viewshed`
- `gdalwarp`
- `gnmanalyse`
- `gnmmanage`
- `nearblack`
- `ogr2ogr`
- `ogrinfo`
- `ogrlineref`
- `ogrtindex`
- `sozip`

## Available Versions

<details>
<summary>Show all 52 versions</summary>

- `3.13.1`, `3.13.0`
- `3.12.4`, `3.12.3`, `3.12.2`, `3.12.1`, `3.12.0`
- `3.11.5`, `3.11.4`, `3.11.3`, `3.11.2`, `3.11.1`, `3.11.0`
- `3.10.3`, `3.10.2`, `3.10.1`, `3.10.0`
- `3.9.3`, `3.9.2`, `3.9.1`, `3.9.0`
- `3.8.5`, `3.8.4`, `3.8.3`, `3.8.2`, `3.8.1`, `3.8.0`
- `3.7.3`, `3.7.2`, `3.7.1`, `3.7.0`
- `3.6.4`, `3.6.3`, `3.6.3RC1`, `3.6.2`, `3.6.1`, `3.6.0`
- `3.5.3`, `3.5.2`, `3.5.1`, `3.5.0`
- `3.4.3`, `3.4.2`, `3.4.1`, `3.4.0`
- `3.3.3`, `3.3.2`, `3.3.1`, `3.3.0`
- `3.2.3`, `3.2.2`, `3.2.1`

</details>

**Latest Version**: `3.13.1`

### Install Specific Version

```bash
# Install specific version
sh <(curl https://pkgx.sh) +gdal.org@3.13.1 -- $SHELL -i
```

## Dependencies

This package depends on:

- `apache.org/arrow@19`
- `heasarc.gsfc.nasa.gov/cfitsio`
- `epsilon-project.sourceforge.io`
- `libexpat.github.io`
- `gaia-gis.it/fossil/freexl`
- `libgeos.org`
- `giflib.sourceforge.io`
- `libjpeg-turbo.org`
- `jpeg.org/jpegxl`
- `github.com/json-c/json-c`
- `libarchive.org`
- `github.com/OSGeo/libgeotiff`
- `github.com/strukturag/libheif`
- `github.com/libkml/libkml`
- `github.com/Esri/lerc`
- `libpng.org`
- `postgresql.org/libpq`
- `gaia-gis.it/libspatialite`
- `simplesystems.org/libtiff`
- `gnome.org/libxml2~2.13 # 2.14 changed the soname`
- `numpy.org`
- `openexr.com`
- `openjpeg.org`
- `openssl.org`
- `pcre.org/v2`
- `poppler.freedesktop.org`
- `proj.org`
- `python.org~3.11`
- `qhull.org`
- `sqlite.org`
- `unixodbc.org`
- `google.com/webp`
- `xerces.apache.org/xerces-c`
- `tukaani.org/xz`
- `facebook.com/zstd`
- `protobuf.dev`
- `abseil.io`
- `zlib.net`
- `dkrz.de/libaec`
- `github.com/ebiggers/libdeflate`
- `linux:curl.se`
- `linux:github.com/util-linux/util-linux`
- `linux:apache.org/thrift=0.22.0 # since 3.11.1`

## Usage Examples

```typescript
import { pantry } from 'ts-pkgx'

// Access this package
const pkg = pantry.gdal

console.log(`Package: ${pkg.name}`)
console.log(`Description: ${pkg.description}`)
console.log(`Programs: ${pkg.programs.join(', ')}`)
```

## Links

- [Package Source](https://github.com/pkgxdev/pantry/tree/main/projects/gdal.org/package.yml)
- [Homepage](https://www.gdal.org/)
- [Back to Package Catalog](../../package-catalog.md)

---

> Auto-generated from package data.
