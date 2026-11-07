import { stat, readFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function verifyClaudeBundle(app: string, version: string): Promise<void> {
  const plist = await readFile(join(app, 'Contents/Info.plist'), 'utf8')
  const value = (key: string) => plist.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`))?.[1]
  if (value('CFBundleIdentifier') !== 'com.anthropic.claudefordesktop' || value('CFBundleShortVersionString') !== version || value('CFBundleExecutable') !== 'Claude') throw new Error('Claude bundle identity or version does not match the requested package')
  const executable = await stat(join(app, 'Contents/MacOS/Claude'))
  if (!executable.isFile() || executable.size === 0 || !(executable.mode & 0o111)) throw new Error('Claude application executable is missing or not executable')

}

if (import.meta.main) await verifyClaudeBundle(process.argv[2]!, process.argv[3]!)
