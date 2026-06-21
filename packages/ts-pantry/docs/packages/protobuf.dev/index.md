# Protocol Buffers

> Protocol Buffers - Google's data interchange format

## Package Information

- **Domain**: `protobuf.dev`
- **Name**: `Protocol Buffers`
- **Homepage**: <https://protobuf.dev/>
- **Source**: [View on GitHub](https://github.com/pkgxdev/pantry/tree/main/projects/protobuf.dev/package.yml)

## Installation

```bash
# Install with pantry
pantry install protobuf.dev
```

## Programs

This package provides the following executable programs:

- `protoc`

## Available Versions

<details>
<summary>Show all 49 versions</summary>

- `35.1`
- `35.0`
- `34.2`
- `34.1`, `34.1.0`
- `34.0`, `34.0.0`
- `33.6`, `33.6.0`
- `33.5`, `33.5.0`
- `33.4`, `33.4.0`
- `33.3`, `33.3.0`
- `33.2`, `33.2.0`
- `33.1`, `33.1.0`
- `33.0`, `33.0.0`
- `32.1`, `32.1.0`
- `32.0`
- `31.1`
- `31.0`
- `30.2`
- `30.1`
- `30.0`
- `29.6`
- `29.5`
- `29.4`
- `29.3`
- `29.2`
- `29.1`
- `29.0`
- `28.3`
- `28.2`
- `28.1`
- `28.0`
- `27.5`
- `27.4`
- `27.3`
- `25.9`
- `25.8`
- `25.7`
- `25.6`
- `25.5`
- `25.4`

</details>

**Latest Version**: `35.1`

### Install Specific Version

```bash
# Install specific version
sh <(curl https://pkgx.sh) +protobuf.dev@35.1 -- $SHELL -i
```

## Dependencies

This package depends on:

- `zlib.net^1`
- `abseil.io`

## Usage Examples

```typescript
import { pantry } from 'ts-pkgx'

// Access this package
const pkg = pantry['Protocol Buffers']

console.log(`Package: ${pkg.name}`)
console.log(`Description: ${pkg.description}`)
console.log(`Programs: ${pkg.programs.join(', ')}`)
```

## Links

- [Package Source](https://github.com/pkgxdev/pantry/tree/main/projects/protobuf.dev/package.yml)
- [Homepage](https://protobuf.dev/)
- [Back to Package Catalog](../../package-catalog.md)

---

> Auto-generated from package data.
