import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
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
  const temporary = `${executable}.${crypto.randomUUID()}.tmp`
  const build = Bun.spawn([process.execPath, 'build', options.entrypoint, '--compile', '--minify', '--no-compile-autoload-dotenv', '--no-compile-autoload-bunfig', '--outfile', temporary], { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' })
  if (await build.exited !== 0) {
    rmSync(temporary, { force: true })
    throw new Error('Could not build the standalone Pantry desktop service')
  }
  chmodSync(temporary, 0o700)
  renameSync(temporary, executable)
  const agents = join(homedir(), 'Library/LaunchAgents')
  mkdirSync(agents, { recursive: true })
  const plist = join(agents, 'dev.pantry.desktop.plist')
  writeFileSync(plist, desktopServicePlist(executable, pantry, directory), { mode: 0o600 })
  const domain = `gui/${process.getuid()}`
  await registerDesktopService(domain, plist)
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const response = await fetch('http://127.0.0.1:46473/health', { signal: AbortSignal.timeout(500) })
      const health = await response.json() as { service?: string, protocolVersion?: number }
      if (response.ok && health.service === 'pantry-desktop' && health.protocolVersion === 1) return
    }
    catch {}
    await Bun.sleep(250)
  }
  throw new Error(`Pantry Desktop did not become ready. Check ${join(directory, 'service.log')}`)
}
function createPrivateDirectory(directory: string) {
  // Generate no credentials here; this validates the service storage itself.
  secureDesktopDirectory(directory)
  const file = join(directory, 'service.log')
  writeFileSync(file, '', { mode: 0o600, flag: 'a' })
  chmodSync(file, 0o600)
}


interface ServiceCommandResult { exitCode: number, stderr: string }
export async function registerDesktopService(domain: string, plist: string, options: {
  run?: (args: string[]) => Promise<ServiceCommandResult>
  sleep?: (milliseconds: number) => Promise<unknown>
} = {}): Promise<void> {
  const run = options.run ?? (async (args: string[]) => {
    const child = Bun.spawn(['launchctl', ...args], { stdout: 'ignore', stderr: 'pipe' })
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
    return { exitCode, stderr }
  })
  await run(['bootout', `${domain}/dev.pantry.desktop`])
  for (let attempt = 0; attempt < 6; attempt++) {
    const result = await run(['bootstrap', domain, plist])
    if (result.exitCode === 0) return
    if (attempt === 5 || !/Bootstrap failed: 5: Input\/output error/.test(result.stderr))
      throw new Error(`macOS did not register the Pantry desktop service: ${result.stderr.trim()}`)
    // launchd can still be removing a stopped job when bootout has returned.
    await (options.sleep ?? Bun.sleep)(100 * 2 ** attempt)
  }
}
