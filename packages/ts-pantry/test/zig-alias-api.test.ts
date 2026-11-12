import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { generateZigAliases } from '../src/generate-zig'
import { generateAliases } from '../src/generate'

const zig = process.env.PANTRY_ZIG_TEST_BIN || Bun.which('zig')
test.skipIf(!zig)('regenerated aliases compile against the native registry API', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pantry native aliases '))
  try {
    const packages = join(root, 'packages')
    mkdirSync(packages)
    writeFileSync(join(packages, 'node.ts'), 'export const nodePackage = { domain: "nodejs.org", name: "node", programs: ["node"], aliases: ["nodejs"] }')
    writeFileSync(join(packages, 'native.ts'), 'export const nativePackage = { domain: "zig-dtsx.stacksjs.org", name: "dtsx-native", programs: ["zig-dtsx"], aliases: ["zig-dtsx"] }')
    const aliases = join(root, 'aliases.zig')
    await generateZigAliases(packages, aliases)
    await generateAliases(packages)
    const typescript = await import(pathToFileURL(join(packages, 'aliases.ts')).href)
    expect(typescript.aliases['dtsx-native']).toBe('zig-dtsx.stacksjs.org')
    expect(Object.hasOwn(typescript.aliases, 'zig-dtsx')).toBe(false)
    const main = join(root, 'main.zig')
    writeFileSync(main, `const std = @import("std");
const aliases = @import("aliases");
test "native registry contract" {
    try std.testing.expectEqualStrings("nodejs.org", aliases.resolveAlias("node") orelse return error.MissingAlias);
    try std.testing.expectEqualStrings("nodejs.org", aliases.resolveAlias("nodejs") orelse return error.MissingAlias);
    try std.testing.expectEqualStrings("zig-dtsx.stacksjs.org", aliases.resolveAlias("dtsx-native") orelse return error.MissingAlias);
    try std.testing.expect(aliases.resolveAlias("zig-dtsx") == null);
    try std.testing.expect(aliases.resolveAlias("__pantry_unknown_alias__") == null);
}
`)
    const p = Bun.spawnSync([zig!, 'test', '--dep', 'aliases', `-Mroot=${main}`, `-Maliases=${aliases}`], { cwd: root, stdout: 'pipe', stderr: 'pipe', timeout: 25_000 })
    expect(p.exitCode, p.stdout.toString() + p.stderr.toString()).toBe(0)
  }
  finally { rmSync(root, { recursive: true, force: true }) }
}, 30_000)
