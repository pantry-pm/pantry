# zookeeper

> Apache ZooKeeper distributed coordination service

## Package Information

- **Domain**: `zookeeper.apache.org`
- **Name**: `zookeeper`
- **Homepage**: <https://zookeeper.apache.org>
- **Source**: [View on GitHub](https://github.com/pantry-pm/pantry/tree/main/projects/zookeeper.apache.org/package.yml)

## Installation

```bash
# Install with pantry
pantry install zookeeper.apache.org
```

## Programs

This package provides the following executable programs:

- `zkServer.sh`
- `zkCli.sh`

## Available Versions

<details>
<summary>Show all 49 versions</summary>

- `3.9.5`, `3.9.5-0`, `3.9.4`, `3.9.4-2`, `3.9.4-1`, `3.9.4-0`, `3.9.3`, `3.9.3-2`, `3.9.3-1`, `3.9.3-0`, `3.9.2`, `3.9.2-0`, `3.9.1`, `3.9.1-0`, `3.9.0`, `3.9.0-1`, `3.9.0-0`
- `3.8.6`, `3.8.6-1`, `3.8.6-0`, `3.8.5`, `3.8.5-0`, `3.8.4`, `3.8.4-0`, `3.8.3`, `3.8.3-0`, `3.8.2`, `3.8.2-0`, `3.8.1`, `3.8.1-1`, `3.8.1-0`, `3.8.0-1`, `3.8.0-0`
- `3.7.3-0`, `3.7.2`, `3.7.2-0`, `3.7.1`, `3.7.1-1`, `3.7.1-0`, `3.7.0`, `3.7.0-2`, `3.7.0-1`, `3.7.0-0`
- `3.6.4`, `3.6.4-2`, `3.6.4-1`, `3.6.4-0`, `3.6.3`, `3.6.3-2`

</details>

**Latest Version**: `3.9.5`

### Install Specific Version

```bash
# Install a specific version
pantry install zookeeper.apache.org@3.9.5
```

## Dependencies

This package depends on:

- `openjdk.org`

## Usage Examples

```typescript
import { pantry } from 'ts-pantry'

// Access this package
const pkg = pantry.zookeeper

console.log(`Package: ${pkg.name}`)
console.log(`Description: ${pkg.description}`)
console.log(`Programs: ${pkg.programs.join(', ')}`)
```

## Links

- [Package Source](https://github.com/pantry-pm/pantry/tree/main/projects/zookeeper.apache.org/package.yml)
- [Homepage](https://zookeeper.apache.org)
- [Back to Package Catalog](../../package-catalog.md)

---

> Auto-generated from package data.
