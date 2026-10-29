#!/usr/bin/env bun
import { CLI } from '@stacksjs/clapp'
import { createDesktopPairingCode, startDesktopBridge } from '../src/desktop/service'
import { setupDesktopBridge } from '../src/desktop/setup'

const cli = new CLI('pantry-desktop')
cli.command('serve', 'Run the authenticated local Pantry desktop bridge')
  .option('--pantry <path>', 'Absolute path to the installed Pantry CLI')
  .action((options: { pantry?: string }) => {
    const bridge = startDesktopBridge({ pantryExecutable: options.pantry })
    console.log(`Pantry Desktop ready at http://127.0.0.1:${bridge.server.port}`)
    const stop = () => { void bridge.close().then(() => process.exit(0)) }
    process.once('SIGTERM', stop)
    process.once('SIGINT', stop)
  })
cli.command('pair', 'Create a single-use code for connecting a desktop application')
  .option('--json', 'Print the code as JSON for a local setup client')
  .action((options: { json?: boolean }) => {
    const code = createDesktopPairingCode()
    console.log(options.json ? JSON.stringify({ code, expiresInSeconds: 300 }) : `Pantry pairing code: ${code}\nEnter it in your desktop app within five minutes.`)
  })
cli.command('setup', 'Install the per-user Pantry desktop service, then create a pairing code')
  .option('--yes', 'Allow the per-user service to start now and at login')
  .option('--pantry <path>', 'Absolute path to the installed Pantry CLI')
  .action(async (options: { yes?: boolean, pantry?: string }) => {
    if (!options.yes) throw new Error('This installs a per-user service that starts at login. Run pantry desktop setup --yes to allow it.')
    await setupDesktopBridge({ entrypoint: import.meta.path, pantryExecutable: options.pantry })
    console.log(`Pantry Desktop is installed for this user. Pairing code: ${createDesktopPairingCode()}\nEnter it in your desktop app within five minutes.`)
  })
cli.help()
await cli.parse()
