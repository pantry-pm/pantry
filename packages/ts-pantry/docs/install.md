# Installation

Installing ts-pantry is easy. Simply pull it in via your package manager of choice.

## Package Managers

Choose your package manager of choice:

::: code-group

```sh [npm]
npm install ts-pantry
# npm i ts-pantry

# Or, as a development dependency
npm install --save-dev ts-pantry
```

```sh [bun]
bun install ts-pantry
# bun add ts-pantry

# Or, as a development dependency
bun install --dev ts-pantry
```

```sh [pnpm]
pnpm add ts-pantry
# pnpm i ts-pantry

# Or, as a development dependency
pnpm add --save-dev ts-pantry
```

```sh [yarn]
yarn add ts-pantry
# yarn i ts-pantry

# Or, as a development dependency
yarn add --dev ts-pantry
```

:::

## Global Installation

If you want to use the CLI globally, you can install it globally:

::: code-group

```sh [npm]
npm install -g ts-pantry
```

```sh [bun]
bun install -g ts-pantry
```

```sh [pnpm]
pnpm add -g ts-pantry
```

```sh [yarn]
yarn global add ts-pantry
```

:::

## Using Pre-compiled Binaries

ts-pantry also provides pre-compiled binaries for various platforms. These allow you to use the CLI without needing to install Node.js or Bun:

```sh
# Download the binary for your platform
curl -fsSL https://github.com/pantry-pm/pantry/releases/latest/download/ts-pantry-$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m).zip -o ts-pantry.zip

# Unzip the binary
unzip ts-pantry.zip

# Make it executable
chmod +x ts-pantry

# Move to a directory in your PATH (optional)
sudo mv ts-pantry /usr/local/bin/
```

## Verification

To verify the installation, you can run:

```sh
bun run pkgx:fetch node
```

Or if you installed globally or are using the binary:

```sh
ts-pantry fetch node
```

This should fetch information about the Node.js package from pkgx.dev.

## Requirements

ts-pantry requires:

- Bun runtime

## Next Steps

Once you have ts-pantry installed, check out the [Usage](./usage.md) guide to learn how to use it.
