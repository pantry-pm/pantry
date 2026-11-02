import process from 'node:process'
import { spawn } from 'node:child_process'

export interface CommandResult { exitCode: number, stdout: string, stderr: string }
export interface CommandOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  inherit?: boolean
  input?: string
  /** Optional direct-child deadline, 1..2147483647ms. No implicit timeout. */
  timeoutMs?: number
}
export type NativeCommand = (command: string, args: string[], options?: CommandOptions) => Promise<CommandResult>

/** Argument arrays only: credentials and project paths never pass through a shell. */
export const runNativeCommand: NativeCommand = (command, args, options = {}) => new Promise((resolve, reject) => {
  if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > 2 ** 31 - 1)) {
    reject(new Error('A native command timeout must be a positive integer no greater than 2147483647ms'))
    return
  }
  const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: options.inherit ? 'inherit' : [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', chunk => { stdout += chunk.toString() })
  child.stderr?.on('data', chunk => { stderr += chunk.toString() })
  let timer: ReturnType<typeof setTimeout> | undefined
  let failure: Error | undefined
  let timedOut = false
  const clear = () => { if (timer !== undefined) clearTimeout(timer) }
  const closePipes = () => {
    child.stdin?.destroy()
    child.stdout?.destroy()
    child.stderr?.destroy()
  }
  child.once('error', error => {
    failure = timedOut ? new Error(failure!.message, { cause: error }) : error
    clear()
  })
  child.stdin?.once('error', error => {
    // A timed-out writer can receive EPIPE while its killed child closes.
    // Keep that failure inside the command promise, preserving the deadline.
    failure = timedOut ? new Error(failure!.message, { cause: error }) : error
  })
  child.once('exit', () => {
    if (!timedOut) return
    // Reap the owned child before closing our pipe endpoints. This is not a
    // process-group contract, and it never waits on an abandoned race promise.
    closePipes()
  })
  child.once('close', code => {
    clear()
    if (failure) reject(failure)
    else resolve({ exitCode: code ?? 1, stdout, stderr })
  })
  if (options.timeoutMs !== undefined) {
    timer = setTimeout(() => {
      timedOut = true
      failure = new Error(`Native command timed out after ${options.timeoutMs}ms: ${command}`)
      if (child.exitCode !== null || child.signalCode) closePipes()
      else {
        try { child.kill('SIGKILL') }
        catch (cause) { failure = new Error(failure.message, { cause }) }
      }
      // Only close acknowledges termination. A supported owned command cannot
      // turn an expired deadline into a success by handling TERM or exiting 0.
    }, options.timeoutMs)
  }
  if (options.input !== undefined) child.stdin?.end(options.input)
})

export function succeeded(label: string, result: CommandResult): CommandResult {
  if (result.exitCode !== 0) throw new Error(`${label} failed (${result.exitCode}): ${result.stdout}\n${result.stderr}`.trim())
  return result
}
