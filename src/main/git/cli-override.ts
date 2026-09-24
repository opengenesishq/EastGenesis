import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { buildMinimalSubprocessEnv } from '../security/subprocess-environment'
import { parseWslHostPath } from '../wsl/binding'
import { spawnSyncInExecutionEnvironment } from '../wsl/process'

export interface GitCliOverride {
  executable: string
  argsPrefix: string[]
}

export function gitCliOverride(command: 'gh' | 'glab', cwd?: string): GitCliOverride | undefined {
  // Overrides point to host executables; a WSL task uses its distribution's CLI.
  if (cwd && parseWslHostPath(cwd)) return undefined
  const envName = command === 'gh' ? 'CAOGEN_GH_EXECUTABLE' : 'CAOGEN_GLAB_EXECUTABLE'
  const executable = process.env[envName]?.trim()
  if (!executable) return undefined
  const scriptEnv = command === 'gh' ? 'CAOGEN_GH_SCRIPT' : 'CAOGEN_GLAB_SCRIPT'
  const script = process.env[scriptEnv]?.trim()
  return { executable, argsPrefix: script ? [script] : [] }
}

export function gitCliOverrideExists(command: 'gh' | 'glab'): boolean {
  const override = gitCliOverride(command)
  return Boolean(override && existsSync(override.executable))
}

export function gitCliAvailable(command: 'gh' | 'glab', timeoutMs: number, cwd?: string): boolean {
  if (cwd && parseWslHostPath(cwd)) {
    try {
      return spawnSyncInExecutionEnvironment(command, ['--version'], {
        cwd, env: buildMinimalSubprocessEnv(), stdio: 'ignore', timeout: timeoutMs
      }).status === 0
    } catch { return false }
  }
  if (gitCliOverrideExists(command)) return true
  const probe = process.platform === 'win32' ? 'where' : 'which'
  return spawnSync(probe, [command], {
    env: buildMinimalSubprocessEnv(),
    stdio: 'ignore',
    timeout: timeoutMs
  }).status === 0
}

export function gitCliForProvider(provider: 'github' | 'gitlab'): 'gh' | 'glab' {
  return provider === 'github' ? 'gh' : 'glab'
}
