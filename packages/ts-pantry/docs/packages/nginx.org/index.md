# nginx

> HTTP(S) server and reverse proxy, and IMAP/POP3 proxy server

## Package Information

- **Domain**: `nginx.org`
- **Name**: `nginx`
- **Homepage**: <https://nginx.org/>
- **Source**: [View on GitHub](https://github.com/pkgxdev/pantry/tree/main/projects/nginx.org/package.yml)

## Installation

```bash
# Install with pantry
pantry install nginx.org
```

## Programs

This package provides the following executable programs:

- `nginx`

## Available Versions

<details>
<summary>Show all 38 versions</summary>

- `1.31.2`, `1.31.1`, `1.31.0`
- `1.30.3`, `1.30.2`, `1.30.1`, `1.30.0`
- `1.29.8`, `1.29.7`, `1.29.6`, `1.29.5`, `1.29.4`, `1.29.3`, `1.29.2`, `1.29.1`, `1.29.0`
- `1.28.3`, `1.28.2`, `1.28.1`, `1.28.0`
- `1.27.5`, `1.27.4`, `1.27.3`, `1.27.2`, `1.27.1`, `1.27.0`
- `1.26.3`, `1.26.2`, `1.26.1`, `1.26.0`
- `1.25.5`, `1.25.4`, `1.25.3`, `1.25.2`, `1.25.1`, `1.25.0`
- `1.24.0`
- `1.23.3`

</details>

**Latest Version**: `1.31.2`

### Install Specific Version

```bash
# Install a specific version
pantry install nginx.org@1.31.2
```

## Dependencies

This package depends on:

- `pcre.org^8.45 # switch to pcre.org/pcre2 once it`
- `zlib.net^1.2.13`
- `openssl.org^1.1.1k`

## Usage Examples

```typescript
import { pantry } from 'ts-pantry'

// Access this package
const pkg = pantry.nginx

console.log(`Package: ${pkg.name}`)
console.log(`Description: ${pkg.description}`)
console.log(`Programs: ${pkg.programs.join(', ')}`)
```

## Links

- [Package Source](https://github.com/pkgxdev/pantry/tree/main/projects/nginx.org/package.yml)
- [Homepage](https://nginx.org/)
- [Back to Package Catalog](../../package-catalog.md)

---

> Auto-generated from package data.
