import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { desktopStateDirectory, secureDesktopDirectory } from './service'
import { version } from '../../package.json'

const xml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')
export function desktopServicePlist(executable: string, pantry: string, stateDirectory: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>
<key>Label</key><string>dev.pantry.desktop</string>
<key>ProgramArguments</key><array><string>${xml(executable)}</string><string>serve</string><string>--pantry</string><string>${xml(pantry)}</string></array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>WorkingDirectory</key><string>${xml(stateDirectory)}</string>
<key>StandardOutPath</key><string>${xml(join(stateDirectory, 'service.log'))}</string>
<key>StandardErrorPath</key><string>${xml(join(stateDirectory, 'service.log'))}</string>
</dict></plist>\n`
}

/** The separately installed CLI owns this service; an App Store client never installs it. */
export async function setupDesktopBridge(options: { entrypoint: string, pantryExecutable?: string }): Promise<void> {
  if (process.platform !== 'darwin' || !process.getuid || process.getuid() === 0) throw new Error('Pantry desktop service setup requires a macOS user session')
  const pantry = options.pantryExecutable ?? Bun.which('pantry')
  if (!pantry || !isAbsolute(pantry)) throw new Error('Install the Pantry CLI before configuring its desktop service')
  const directory = desktopStateDirectory()
  // Pairing setup also verifies owner-only state permissions.
  createPrivateDirectory(directory)
  const runtime = join(directory, 'runtime')
  mkdirSync(runtime, { recursive: true, mode: 0o700 })
  const executable = join(runtime, `pantry-desktop-${version}`)
  const build = Bun.spawn([process.execPath, 'build', options.entrypoint, '--compile', '--minify', '--no-compile-autoload-dotenv', '--no-compile-autoload-bunfig', '--outfile', executable], { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' })
  if (await build.exited !== 0) throw new Error('Could not build the standalone Pantry desktop service')
  chmodSync(executable, 0o700)
  const agents = join(homedir(), 'Library/LaunchAgents')
  mkdirSync(agents, { recursive: true })
  const plist = join(agents, 'dev.pantry.desktop.plist')
  writeFileSync(plist, desktopServicePlist(executable, pantry, directory), { mode: 0o600 })
  const domain = `gui/${process.getuid()}`
  const previous = Bun.spawn(['launchctl', 'bootout', `${domain}/dev.pantry.desktop`], { stdout: 'ignore', stderr: 'ignore' })
  await previous.exited
  const start = Bun.spawn(['launchctl', 'bootstrap', domain, plist], { stdout: 'inherit', stderr: 'inherit' })
  if (await start.exited !== 0) throw new Error('macOS did not start the Pantry desktop service')
}
function createPrivateDirectory(directory: string) {
  // Generate no credentials here; this validates the service storage itself.
  secureDesktopDirectory(directory)
  const file = join(directory, 'service.log')
  writeFileSync(file, '', { mode: 0o600, flag: 'a' })
  chmodSync(file, 0o600)
}
