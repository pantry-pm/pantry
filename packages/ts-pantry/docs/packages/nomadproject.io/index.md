# nomad

> Nomad is an easy-to-use, flexible, and performant workload orchestrator that can deploy a mix of microservice, batch, containerized, and non-containerized applications. Nomad is easy to operate and scale and has native Consul and Vault integrations.

## Package Information

- **Domain**: `nomadproject.io`
- **Name**: `nomad`
- **Homepage**: <https://www.nomadproject.io>
- **Source**: [View on GitHub](https://github.com/pkgxdev/pantry/tree/main/projects/nomadproject.io/package.yml)

## Installation

```bash
# Install with pantry
pantry install nomadproject.io
```

## Programs

This package provides the following executable programs:

- `nomad`

## Available Versions

<details>
<summary>Show all 53 versions</summary>

- `2.0.3`, `2.0.2`, `2.0.1`, `2.0.0`
- `1.11.3`, `1.11.2`, `1.11.1`, `1.11.0`
- `1.10.5`, `1.10.4`, `1.10.3`, `1.10.2`, `1.10.1`, `1.10.0`
- `1.9.7`, `1.9.6`, `1.9.5`, `1.9.4`, `1.9.3`, `1.9.2`, `1.9.1`, `1.9.0`
- `1.8.4`, `1.8.3`
- `ent-changelog-1.9.9`, `ent-changelog-1.9.8`, `ent-changelog-1.9.13`, `ent-changelog-1.9.12`, `ent-changelog-1.9.11`, `ent-changelog-1.9.10`
- `ent-changelog-1.8.9`, `ent-changelog-1.8.8`, `ent-changelog-1.8.7`, `ent-changelog-1.8.21`, `ent-changelog-1.8.20`, `ent-changelog-1.8.19`, `ent-changelog-1.8.18`, `ent-changelog-1.8.17`, `ent-changelog-1.8.16`, `ent-changelog-1.8.15`, `ent-changelog-1.8.14`, `ent-changelog-1.8.13`, `ent-changelog-1.8.12`, `ent-changelog-1.8.11`, `ent-changelog-1.8.10`
- `ent-changelog-1.7.19`, `ent-changelog-1.7.18`, `ent-changelog-1.7.17`, `ent-changelog-1.7.16`
- `ent-changelog-1.10.9`, `ent-changelog-1.10.8`, `ent-changelog-1.10.7`, `ent-changelog-1.10.6`

</details>

**Latest Version**: `2.0.3`

### Install Specific Version

```bash
# Install specific version
sh <(curl https://pkgx.sh) +nomadproject.io@2.0.3 -- $SHELL -i
```

## Usage Examples

```typescript
import { pantry } from 'ts-pkgx'

// Access this package
const pkg = pantry.nomad

console.log(`Package: ${pkg.name}`)
console.log(`Description: ${pkg.description}`)
console.log(`Programs: ${pkg.programs.join(', ')}`)
```

## Links

- [Package Source](https://github.com/pkgxdev/pantry/tree/main/projects/nomadproject.io/package.yml)
- [Homepage](https://www.nomadproject.io)
- [Back to Package Catalog](../../package-catalog.md)

---

> Auto-generated from package data.
