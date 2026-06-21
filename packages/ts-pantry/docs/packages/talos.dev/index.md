# talosctl

> CLI for out-of-band management of Kubernetes nodes created by Talos

## Package Information

- **Domain**: `talos.dev`
- **Name**: `talosctl`
- **Homepage**: <https://www.talos.dev/>
- **Source**: [View on GitHub](https://github.com/pkgxdev/pantry/tree/main/projects/talos.dev/package.yml)

## Installation

```bash
# Install with pantry
pantry install talos.dev
```

## Programs

This package provides the following executable programs:

- `talosctl`

## Available Versions

<details>
<summary>Show all 35 versions</summary>

- `1.13.4`, `1.13.3`, `1.13.2`, `1.13.1`, `1.13.0`
- `1.12.9`, `1.12.8`, `1.12.7`, `1.12.6`, `1.12.5`, `1.12.4`, `1.12.3`, `1.12.2`, `1.12.1`, `1.12.0`
- `1.11.6`, `1.11.5`, `1.11.4`, `1.11.3`, `1.11.2`, `1.11.1`, `1.11.0`
- `1.10.9`, `1.10.8`, `1.10.7`, `1.10.6`, `1.10.5`, `1.10.4`, `1.10.3`, `1.10.2`, `1.10.1`, `1.10.0`
- `1.9.6`, `1.9.5`, `1.9.4`

</details>

**Latest Version**: `1.13.4`

### Install Specific Version

```bash
# Install a specific version
pantry install talos.dev@1.13.4
```

## Usage Examples

```typescript
import { pantry } from 'ts-pantry'

// Access this package
const pkg = pantry.talosctl

console.log(`Package: ${pkg.name}`)
console.log(`Description: ${pkg.description}`)
console.log(`Programs: ${pkg.programs.join(', ')}`)
```

## Links

- [Package Source](https://github.com/pkgxdev/pantry/tree/main/projects/talos.dev/package.yml)
- [Homepage](https://www.talos.dev/)
- [Back to Package Catalog](../../package-catalog.md)

---

> Auto-generated from package data.
