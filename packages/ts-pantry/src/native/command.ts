import process from 'node:process'
import { spawn } from 'node:child_process'

export interface CommandResult { exitCode: number, stdout: string, stderr: string }
export interface CommandOptions { cwd?: string, env?: NodeJS.ProcessEnv, inherit?: boolean }
export type NativeCommand = (command: string, args: string[], options?: CommandOptions) => Promise<CommandResult>

/** Argument arrays only: credentials and project paths never pass through a shell. */
export const runNativeCommand: NativeCommand = (command, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: options.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', chunk => { stdout += chunk.toString() })
  child.stderr?.on('data', chunk => { stderr += chunk.toString() })
  child.once('error', reject)
  child.once('close', code => resolve({ exitCode: code ?? 1, stdout, stderr }))
})

export function succeeded(label: string, result: CommandResult): CommandResult {
  if (result.exitCode !== 0) throw new Error(`${label} failed (${result.exitCode}): ${result.stdout}\n${result.stderr}`.trim())
  return result
}
