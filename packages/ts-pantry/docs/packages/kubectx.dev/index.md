# kube

> Tool that can switch between kubectl contexts easily and create aliases

## Package Information

- **Domain**: `kubectx.dev`
- **Name**: `kube`
- **Homepage**: <https://kubectx.dev>
- **Source**: [View on GitHub](https://github.com/pkgxdev/pantry/tree/main/projects/kubectx.dev/package.yml)

## Installation

```bash
# Install with pantry
pantry install kubectx.dev
```

## Programs

This package provides the following executable programs:

- `kubectx`
- `kubens`

## Available Versions

<details>
<summary>Show all 26 versions</summary>

- `0.11.0`
- `0.10.2`, `0.10.1`, `0.10.1-rc.1`, `0.10.0`
- `0.9.5`, `0.9.4`, `0.9.3`, `0.9.2`, `0.9.1`, `0.9.0`
- `0.8.0`
- `0.7.1`, `0.7.0`
- `0.6.3`, `0.6.2`, `0.6.1`, `0.6.0`
- `0.5.1`, `0.5.0`
- `0.4.1`, `0.4.0`
- `0.3.1`, `0.3.0`
- `0.2.0`
- `0.1`

</details>

**Latest Version**: `0.11.0`

### Install Specific Version

```bash
# Install specific version
sh <(curl https://pkgx.sh) +kubectx.dev@0.11.0 -- $SHELL -i
```

## Dependencies

This package depends on:

- `github.com/junegunn/fzf`

## Usage Examples

```typescript
import { pantry } from 'ts-pkgx'

// Access this package
const pkg = pantry.kube

console.log(`Package: ${pkg.name}`)
console.log(`Description: ${pkg.description}`)
console.log(`Programs: ${pkg.programs.join(', ')}`)
```

## Links

- [Package Source](https://github.com/pkgxdev/pantry/tree/main/projects/kubectx.dev/package.yml)
- [Homepage](https://kubectx.dev)
- [Back to Package Catalog](../../package-catalog.md)

---

> Auto-generated from package data.
