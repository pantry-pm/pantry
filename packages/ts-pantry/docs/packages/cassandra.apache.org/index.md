# cassandra

> Apache Cassandra wide-column distributed database

## Package Information

- **Domain**: `cassandra.apache.org`
- **Name**: `cassandra`
- **Homepage**: <https://cassandra.apache.org>
- **Source**: [View on GitHub](https://github.com/pantry-pm/pantry/tree/main/projects/cassandra.apache.org/package.yml)

## Installation

```bash
# Install with pantry
pantry install cassandra.apache.org
```

## Programs

This package provides the following executable programs:

- `cassandra`
- `nodetool`
- `cqlsh`

## Available Versions

<details>
<summary>Show all 50 versions</summary>

- `6.0-alpha1`
- `5.0.8`, `5.0.7`, `5.0.6`, `5.0.5`, `5.0.4`, `5.0.3`, `5.0.2`, `5.0.1`, `5.0.0`
- `5.0-rc2`
- `5.0-rc1`
- `5.0-beta1`
- `5.0-alpha2`
- `5.0-alpha1`
- `4.1.11`, `4.1.10`, `4.1.9`, `4.1.8`, `4.1.7`, `4.1.6`, `4.1.5`, `4.1.4`, `4.1.3`, `4.1.2`, `4.1.1`, `4.1.0`
- `4.1-rc1`
- `4.1-beta1`
- `4.1-alpha1`
- `4.0.20`, `4.0.19`, `4.0.18`, `4.0.17`, `4.0.16`, `4.0.15`, `4.0.14`, `4.0.13`, `4.0.12`, `4.0.11`, `4.0.10`, `4.0.9`, `4.0.8`, `4.0.7`, `4.0.6`, `4.0.5`, `4.0.4`, `4.0.3`, `4.0.2`, `4.0.1`

</details>

**Latest Version**: `6.0-alpha1`

### Install Specific Version

```bash
# Install a specific version
pantry install cassandra.apache.org@6.0-alpha1
```

## Dependencies

This package depends on:

- `openjdk.org`

## Usage Examples

```typescript
import { pantry } from 'ts-pantry'

// Access this package
const pkg = pantry.cassandra

console.log(`Package: ${pkg.name}`)
console.log(`Description: ${pkg.description}`)
console.log(`Programs: ${pkg.programs.join(', ')}`)
```

## Links

- [Package Source](https://github.com/pantry-pm/pantry/tree/main/projects/cassandra.apache.org/package.yml)
- [Homepage](https://cassandra.apache.org)
- [Back to Package Catalog](../../package-catalog.md)

---

> Auto-generated from package data.
