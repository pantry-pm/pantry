# mitmproxy

> An interactive TLS-capable intercepting HTTP proxy for penetration testers and software developers.

## Package Information

- **Domain**: `mitmproxy.org`
- **Name**: `mitmproxy`
- **Homepage**: <https://mitmproxy.org>
- **Source**: [View on GitHub](https://github.com/pkgxdev/pantry/tree/main/projects/mitmproxy.org/package.yml)

## Installation

```bash
# Install with pantry
pantry install mitmproxy.org
```

## Programs

This package provides the following executable programs:

- `mitmproxy`

## Available Versions

<details>
<summary>Show all 53 versions</summary>

- `12.2.3`, `12.2.2`, `12.2.1`, `12.2.0`
- `12.1.2`, `12.1.1`, `12.1.0`
- `12.0.1`, `12.0.0`
- `11.1.3`, `11.1.2`, `11.1.1`, `11.1.0`
- `11.0.2`, `11.0.1`, `11.0.0`
- `10.4.2`, `10.4.1`, `10.4.0`
- `10.3.1`, `10.3.0`
- `10.2.4`, `10.2.3`, `10.2.2`, `10.2.1`, `10.2.0`
- `10.1.6`, `10.1.5`, `10.1.4`, `10.1.3`, `10.1.2`, `10.1.1`, `10.1.0`
- `10.0.0`
- `9.0.1`, `9.0.0`
- `8.1.1`, `8.1.0`
- `8.0.0`
- `7.0.4`, `7.0.3`, `7.0.2`, `7.0.1`, `7.0.0`
- `6.0.2`, `6.0.1`, `6.0.0`
- `5.3.0`
- `5.2`
- `5.1.1`, `5.1.0`
- `5.0.1`, `5.0.0`

</details>

**Latest Version**: `12.2.3`

### Install Specific Version

```bash
# Install specific version
sh <(curl https://pkgx.sh) +mitmproxy.org@12.2.3 -- $SHELL -i
```

## Dependencies

This package depends on:

- `pkgx.sh>=1`

## Usage Examples

```typescript
import { pantry } from 'ts-pkgx'

// Access this package
const pkg = pantry.mitmproxy

console.log(`Package: ${pkg.name}`)
console.log(`Description: ${pkg.description}`)
console.log(`Programs: ${pkg.programs.join(', ')}`)
```

## Links

- [Package Source](https://github.com/pkgxdev/pantry/tree/main/projects/mitmproxy.org/package.yml)
- [Homepage](https://mitmproxy.org)
- [Back to Package Catalog](../../package-catalog.md)

---

> Auto-generated from package data.
