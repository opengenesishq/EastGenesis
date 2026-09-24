import { execFile, execFileSync, spawnSync, type ExecFileSyncOptions, type SpawnSyncOptions, type ExecFileOptions } from 'node:child_process'
import { win32 } from 'node:path'
import type { WslExecutionBinding } from '../../shared/wsl-types'
import { guestPathToHost, parseWslHostPath, wslBindingForCwd } from './binding'
import { runWslProbe, wslExecutable } from './discovery'
import { buildMinimalSubprocessEnv } from '../security/subprocess-environment'

export function executionPathToHost(cwd: string, path: string): string {
  const binding = wslBindingForCwd(cwd)
  return binding && path.startsWith('/') ? guestPathToHost(binding.distribution, path) : path
}
function pathToGuest(binding: WslExecutionBinding, path: string, probe = runWslProbe): string {
  const parsed = parseWslHostPath(path)
  if (parsed) {
    if (parsed.distribution !== binding.distribution) throw new Error('Git 路径不能跨 WSL 发行版。')
    return parsed.guestPath
  }
  if (!win32.isAbsolute(path)) return path
  if (!/^[A-Za-z]:\\/.test(path) || /[\0\r\n]/.test(path)) throw new Error('无法可靠映射此 Windows 路径到 WSL。')
  const script = 'set -eu; p=$(wslpath -u "$1"); printf "%s\\n" "$p"; wslpath -w "$p"'
  const lines = probe(['--distribution', binding.distribution, '--exec', '/bin/sh', '-c', script, 'caogen-map', path]).toString('utf8').trimEnd().split(/\r?\n/)
  if (lines.length !== 2 || !lines[0].startsWith('/') || win32.normalize(lines[1]).toLowerCase() !== win32.normalize(path).toLowerCase()) throw new Error('Windows 临时文件不能可靠映射到所选 WSL 发行版。')
  return lines[0]
}
function mapArgument(binding: WslExecutionBinding, value: string, probe = runWslProbe): string {
  if (/^(?:core\.hooksPath|include\.path)=NUL$/i.test(value)) return `${value.slice(0, value.indexOf('=') + 1)}/dev/null`
  if (/^(?:[A-Za-z]:\\|\\\\)/.test(value)) return pathToGuest(binding, value, probe)
  const equal = value.indexOf('=')
  if (equal > 0 && /^(?:[A-Za-z]:\\|\\\\)/.test(value.slice(equal + 1))) return `${value.slice(0, equal + 1)}${pathToGuest(binding, value.slice(equal + 1), probe)}`
  return value
}
export function parseGitAlternatePaths(value: string): string[] {
  const paths: string[] = []; let current = '', quoted = false
  for (let i = 0; i < value.length; i++) {
    const char = value[i]
    if (char === '"') { quoted = !quoted; continue }
    if (char === '\\' && quoted) {
      const octal = /^[0-7]{3}/.exec(value.slice(i + 1))
      if (octal) { current += String.fromCharCode(parseInt(octal[0], 8)); i += 3; continue }
      if (value[i + 1] === '\\' || value[i + 1] === '"') { current += value[++i]; continue }
      throw new Error('Git 对象目录包含无法解析的转义。')
    }
    if (char === ';' && !quoted) { if (current) paths.push(current); current = ''; continue }
    current += char
  }
  if (quoted) throw new Error('Git 对象目录引号未闭合。')
  if (current) paths.push(current)
  return paths
}
export interface ExecutionProcessHost {
  bindingForCwd: typeof wslBindingForCwd; probe: typeof runWslProbe; executable(): string; systemRoot?: string
}
export function prepareExecutionProcess(file: string, args: readonly string[], options: { cwd?: unknown; env?: NodeJS.ProcessEnv; timeout?: number } = {},
  host: ExecutionProcessHost = { bindingForCwd: wslBindingForCwd, probe: runWslProbe, executable: wslExecutable, systemRoot: process.env.SystemRoot }): {
  file: string; args: string[]; cwd?: string; env?: NodeJS.ProcessEnv; binding?: WslExecutionBinding
} {
  const pathArg = args.indexOf('-C')
  const cwd = typeof options.cwd === 'string' ? options.cwd : pathArg >= 0 ? args[pathArg + 1] : undefined
  if (!cwd || !parseWslHostPath(cwd)) return { file, args: [...args], cwd, env: options.env }
  const binding = host.bindingForCwd(cwd)!
  if (!binding) throw new Error('WSL 执行环境未绑定。')
  if (!['git', 'gh', 'glab'].includes(file)) throw new Error(`此 WSL 工作区尚不支持宿主程序 ${win32.basename(file)}，不会回退宿主执行。`)
  const env: string[] = []
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value === undefined || !/^(?:GIT_|GITLAB_|GH_|GLAB_)/.test(key)) continue
    if (/\0/.test(value)) throw new Error('Git 环境参数无效。')
    const mapped = value.toLowerCase() === 'nul' ? '/dev/null'
      : key === 'GIT_ALTERNATE_OBJECT_DIRECTORIES' ? parseGitAlternatePaths(value).map(path => JSON.stringify(pathToGuest(binding, path, host.probe))).join(':')
        : mapArgument(binding, value, host.probe)
    env.push(`${key}=${mapped}`)
  }
  const seconds = Math.max(1, Math.ceil((options.timeout ?? 120000) / 1000))
  return { binding, file: host.executable(), args: ['--distribution', binding.distribution, '--cd', parseWslHostPath(cwd)!.guestPath,
    '--exec', '/usr/bin/env', ...env, '/usr/bin/timeout', '--signal=TERM', '--kill-after=2s', `${seconds}s`, file, ...(file === 'git' ? ['-c', 'core.quotePath=false'] : []), ...args.map(arg => mapArgument(binding, arg, host.probe))],
    cwd: host.systemRoot, env: buildMinimalSubprocessEnv() }
}
export function convertExecutionOutput(value: string | Buffer | null, args: readonly string[], binding?: WslExecutionBinding): string | Buffer | null {
  if (!binding || value === null) return value
  const absolute = args.includes('rev-parse') && args.some(arg => ['--show-toplevel', '--absolute-git-dir', '--git-common-dir', '--git-dir', '--git-path'].includes(arg))
  const worktrees = args.includes('worktree') && args.includes('list') && args.includes('--porcelain')
  if (!absolute && !worktrees) return value
  const separator = worktrees && args.includes('-z') ? '\0' : '\n'
  const text = value.toString().split(separator).map(line => {
    if (absolute && line.startsWith('/')) return guestPathToHost(binding.distribution, line.replace(/\r$/, ''))
    if (worktrees && line.startsWith('worktree /')) return `worktree ${guestPathToHost(binding.distribution, line.slice(9).replace(/\r$/, ''))}`
    return line
  }).join(separator)
  return Buffer.isBuffer(value) ? Buffer.from(text) : text
}
export const execFileSyncInExecutionEnvironment: typeof execFileSync = ((file: string, argsOrOptions?: string[] | ExecFileSyncOptions, supplied?: ExecFileSyncOptions) => {
  const args = Array.isArray(argsOrOptions) ? argsOrOptions : []
  const options = (Array.isArray(argsOrOptions) ? supplied : argsOrOptions) ?? {}
  const launch = prepareExecutionProcess(file, args, options)
  if (!launch.binding) return execFileSync(file, args, options)
  return convertExecutionOutput(execFileSync(launch.file, launch.args, { ...options, cwd: launch.cwd, env: launch.env, windowsHide: true }), args, launch.binding)
}) as typeof execFileSync
export const spawnSyncInExecutionEnvironment: typeof spawnSync = ((file: string, argsOrOptions?: string[] | SpawnSyncOptions, supplied?: SpawnSyncOptions) => {
  const args = Array.isArray(argsOrOptions) ? argsOrOptions : []
  const options = (Array.isArray(argsOrOptions) ? supplied : argsOrOptions) ?? {}
  const launch = prepareExecutionProcess(file, args, options)
  if (!launch.binding) return spawnSync(file, args, options)
  const result = spawnSync(launch.file, launch.args, { ...options, cwd: launch.cwd, env: launch.env, windowsHide: true })
  result.stdout = convertExecutionOutput(result.stdout, args, launch.binding) as typeof result.stdout
  if (result.output) result.output[1] = result.stdout
  return result
}) as typeof spawnSync
export const execFileInExecutionEnvironment: typeof execFile = ((file: string, ...input: unknown[]) => {
  const args = Array.isArray(input[0]) ? input.shift() as string[] : []
  const options = input[0] && typeof input[0] === 'object' ? input.shift() as ExecFileOptions : {}
  const callback = input[0] as ((error: unknown, stdout: string | Buffer, stderr: string | Buffer) => void) | undefined
  const launch = prepareExecutionProcess(file, args, options)
  if (!launch.binding) return execFile(file, args, options, callback as never)
  return execFile(launch.file, launch.args, { ...options, cwd: launch.cwd, env: launch.env, windowsHide: true }, (error, stdout, stderr) => {
    callback?.(error, convertExecutionOutput(stdout, args, launch.binding) ?? '', stderr)
  })
}) as typeof execFile
