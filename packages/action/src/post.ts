import * as core from '@actions/core'
import * as exec from '@actions/exec'

async function cleanup(): Promise<void> {
  if (core.getState('redis-started') !== 'true') return
  const client = core.getState('redis-cli')
  if (!client) return
  await exec.exec(client, ['-h', '127.0.0.1', '-p', '6379', 'shutdown', 'nosave'], { silent: true }).catch(() => {})
  core.info('Stopped Pantry Redis service')
}

cleanup().catch(error => core.warning(error instanceof Error ? error.message : String(error)))
