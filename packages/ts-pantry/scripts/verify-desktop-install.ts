import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { bundledPackageCatalog } from '../src/catalog/client'
import { PantryDesktopClient } from '../src/desktop/client'
import { createDesktopPairingCode, startDesktopBridge } from '../src/desktop/service'

// Opt-in native acceptance: this installs the requested app for the current user.
const domain = process.argv[2]
const pantry = process.argv[3] || Bun.which('pantry')
assert.equal(process.platform, 'darwin', 'Desktop acceptance requires macOS')
assert.ok(domain && bundledPackageCatalog().some(entry => entry.domain === domain && entry.kind === 'app'), 'Choose an application from the Pantry catalog')
assert.ok(pantry && isAbsolute(pantry), 'Provide the native Pantry executable')
const directory = mkdtempSync(join(tmpdir(), 'pantry-desktop-acceptance-'))
const bridge = startDesktopBridge({ port: 0, stateDirectory: directory, pantryExecutable: pantry })
try {
  const baseUrl = `http://127.0.0.1:${bridge.server.port}`
  const token = await new PantryDesktopClient({ baseUrl }).pair(createDesktopPairingCode(directory), 'Native acceptance')
  const client = new PantryDesktopClient({ baseUrl, token })
  let job = await client.install(domain!)
  const deadline = Date.now() + 600000
  while (['queued', 'running'].includes(job.status) && Date.now() < deadline) {
    await Bun.sleep(250)
    job = await client.job(job.id)
  }
  assert.equal(job.status, 'succeeded', job.error || job.output)
  const installed = (await client.installed()).filter(item => item.name === domain)
  assert.equal(installed.length, 1, 'Installed applications must be deduplicated')
  const application = installed[0]!
  assert.ok(application.applicationPath, 'The installed app must have a launchable bundle path')
  const signature = Bun.spawnSync(['/usr/bin/codesign', '--verify', '--deep', '--strict', application.applicationPath], { stdout: 'pipe', stderr: 'pipe' })
  assert.equal(signature.exitCode, 0, new TextDecoder().decode(signature.stderr))
  console.log(JSON.stringify({ domain, version: application.version, applicationPath: application.applicationPath, status: job.status, signatureVerified: true }, null, 2))
}
finally {
  await bridge.close()
  rmSync(directory, { recursive: true, force: true })
}
