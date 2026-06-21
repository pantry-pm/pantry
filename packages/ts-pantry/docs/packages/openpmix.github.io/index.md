# openpmix.github

> Process Management Interface for HPC environments

## Package Information

- **Domain**: `openpmix.github.io`
- **Name**: `openpmix.github`
- **Homepage**: <https://openpmix.github.io/>
- **Source**: [View on GitHub](https://github.com/pkgxdev/pantry/tree/main/projects/openpmix.github.io/package.yml)

## Installation

```bash
# Install with pantry
pantry install openpmix.github.io
```

## Programs

This package provides the following executable programs:

- `palloc`
- `pattrs`
- `pctrl`
- `pevent`
- `plookup`
- `pmix_info`
- `pmixcc`
- `pps`
- `pquery`

## Available Versions

<details>
<summary>Show all 42 versions</summary>

- `6.1.0`
- `6.0.0`
- `5.0.10`, `5.0.9`, `5.0.8`, `5.0.7`, `5.0.6`, `5.0.5`, `5.0.4`, `5.0.3`, `5.0.2`, `5.0.1`, `5.0.0`
- `4.2.9`, `4.2.8`, `4.2.7`, `4.2.6`, `4.2.5`, `4.2.4`, `4.2.3`, `4.2.2`, `4.2.1`, `4.2.0`
- `4.1.3`, `4.1.2`, `4.1.1`, `4.1.0`
- `4.0.1`, `4.0.0`
- `3.2.5`, `3.2.4`, `3.2.3`, `3.2.2`, `3.2.1`, `3.2.0`
- `3.1.7`, `3.1.6`, `3.1.5`, `3.1.4`
- `2.2.5`, `2.2.4`, `2.2.3`

</details>

**Latest Version**: `6.1.0`

### Install Specific Version

```bash
# Install specific version
sh <(curl https://pkgx.sh) +openpmix.github.io@6.1.0 -- $SHELL -i
```

## Dependencies

This package depends on:

- `open-mpi.org/hwloc^2.10`
- `libevent.org^2.1`
- `zlib.net^1.3`

## Usage Examples

```typescript
import { pantry } from 'ts-pkgx'

// Access this package
const pkg = pantry['openpmix.github']

console.log(`Package: ${pkg.name}`)
console.log(`Description: ${pkg.description}`)
console.log(`Programs: ${pkg.programs.join(', ')}`)
```

## Links

- [Package Source](https://github.com/pkgxdev/pantry/tree/main/projects/openpmix.github.io/package.yml)
- [Homepage](https://openpmix.github.io/)
- [Back to Package Catalog](../../package-catalog.md)

---

> Auto-generated from package data.
