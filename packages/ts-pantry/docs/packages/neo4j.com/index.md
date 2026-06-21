# neo4j

> Neo4j graph database (community edition)

## Package Information

- **Domain**: `neo4j.com`
- **Name**: `neo4j`
- **Homepage**: <https://neo4j.com>
- **Source**: [View on GitHub](https://github.com/pkgxdev/pantry/tree/main/projects/neo4j.com/package.yml)

## Installation

```bash
# Install with pantry
pantry install neo4j.com
```

## Programs

This package provides the following executable programs:

- `neo4j`
- `neo4j-admin`
- `cypher-shell`

## Available Versions

<details>
<summary>Show all 53 versions</summary>

- `2026.05.0`
- `2026.04.0`
- `2026.03.1`
- `2026.02.3`, `2026.02.2`
- `2026.01.4`, `2026.01.3`
- `2025.12.1`
- `2025.11.2`
- `2025.10.1`
- `2025.09.0`
- `2025.08.0`
- `2025.07.1`, `2025.07.0`
- `2025.06.2`, `2025.06.1`, `2025.06.0`
- `2025.05.1`, `2025.05.0`
- `2025.04.0`
- `2025.03.0`
- `2025.02.0`
- `2025.01.0`
- `5.26.27`, `5.26.26`, `5.26.25`, `5.26.24`, `5.26.23`, `5.26.22`, `5.26.21`, `5.26.20`, `5.26.19`, `5.26.18`, `5.26.17`, `5.26.16`, `5.26.15`, `5.26.14`, `5.26.13`, `5.26.12`, `5.26.11`, `5.26.10`, `5.26.9`, `5.26.8`, `5.26.7`, `5.26.6`, `5.26.5`, `5.26.4`, `5.26.3`, `5.26.2`, `5.26.1`, `5.26.0`
- `5.25.1`
- `5.24.0`

</details>

**Latest Version**: `2026.05.0`

### Install Specific Version

```bash
# Install specific version
sh <(curl https://pkgx.sh) +neo4j.com@2026.05.0 -- $SHELL -i
```

## Dependencies

This package depends on:

- `openjdk.org`

## Usage Examples

```typescript
import { pantry } from 'ts-pkgx'

// Access this package
const pkg = pantry.neo4j

console.log(`Package: ${pkg.name}`)
console.log(`Description: ${pkg.description}`)
console.log(`Programs: ${pkg.programs.join(', ')}`)
```

## Links

- [Package Source](https://github.com/pkgxdev/pantry/tree/main/projects/neo4j.com/package.yml)
- [Homepage](https://neo4j.com)
- [Back to Package Catalog](../../package-catalog.md)

---

> Auto-generated from package data.
