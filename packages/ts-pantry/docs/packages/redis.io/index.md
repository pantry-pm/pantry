# redis

> Redis is an in-memory database that persists on disk. The data model is key-value, but many different kind of values are supported: Strings, Lists, Sets, Sorted Sets, Hashes, Streams, HyperLogLogs, Bitmaps.

## Package Information

- **Domain**: `redis.io`
- **Name**: `redis`
- **Homepage**: <http://redis.io>
- **Source**: [View on GitHub](https://github.com/pkgxdev/pantry/tree/main/projects/redis.io/package.yml)

## Installation

```bash
# Install with pantry
pantry install redis.io
```

## Programs

This package provides the following executable programs:

- `redis-server`
- `redis-cli`
- `redis-benchmark`

## Available Versions

<details>
<summary>Show all 52 versions</summary>

- `8.8.0`
- `8.6.4`, `8.6.3`, `8.6.2`, `8.6.1`, `8.6.0`
- `8.4.4`, `8.4.3`, `8.4.2`, `8.4.1`, `8.4.0`
- `8.2.7`, `8.2.6`, `8.2.5`, `8.2.4`, `8.2.3`, `8.2.2`, `8.2.1`, `8.2.0`
- `8.0.6`, `8.0.5`, `8.0.4`, `8.0.3`, `8.0.2`, `8.0.1`, `8.0.0`
- `7.4.9`, `7.4.8`, `7.4.7`, `7.4.6`, `7.4.5`, `7.4.4`, `7.4.3`, `7.4.2`, `7.4.1`, `7.4.0`
- `7.2.14`, `7.2.13`, `7.2.12`, `7.2.11`, `7.2.10`, `7.2.9`, `7.2.8`, `7.2.7`, `7.2.6`
- `6.2.22`, `6.2.21`, `6.2.20`, `6.2.19`, `6.2.18`, `6.2.17`, `6.2.16`

</details>

**Latest Version**: `8.8.0`

### Install Specific Version

```bash
# Install a specific version
pantry install redis.io@8.8.0
```

## Dependencies

This package depends on:

- `openssl.org^1`

## Usage Examples

```typescript
import { pantry } from 'ts-pantry'

// Access this package
const pkg = pantry.redis

console.log(`Package: ${pkg.name}`)
console.log(`Description: ${pkg.description}`)
console.log(`Programs: ${pkg.programs.join(', ')}`)
```

## Links

- [Package Source](https://github.com/pkgxdev/pantry/tree/main/projects/redis.io/package.yml)
- [Homepage](http://redis.io)
- [Back to Package Catalog](../../package-catalog.md)

---

> Auto-generated from package data.
