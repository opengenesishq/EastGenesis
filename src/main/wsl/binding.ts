import { realpathSync, statSync } from 'node:fs'
import { win32, posix } from 'node:path'
import type { ExecutionEnvironmentBinding, ExecutionEnvironmentSelection, WslExecutionBinding, WslPreferences } from '../../shared/wsl-types'
import { assertWslDistribution, runWslProbe } from './discovery'

const bindings = new Map<string, WslExecutionBinding>()
export function parseWslHostPath(value: string): { distribution: string; guestPath: string } | undefined {
  const path = value.replaceAll('/', '\\').replace(/^\\\\\?\\UNC\\/i, '\\\\')
  const match = /^\\\\(?:wsl\.localhost|wsl\$)\\([A-Za-z0-9][A-Za-z0-9._-]{0,127})(\\.*)?$/i.exec(path)
  if (!match || /[\0\r\n]/.test(value)) {
    if (/^\\\\(?:wsl\.localhost|wsl\$)(?:\\|$)/i.test(path)) throw new Error('WSL 共享路径或发行版名称无效，不允许宿主机回退。')
    return undefined
  }
  const parts = (match[2] ?? '\\').split('\\').filter(Boolean)
  if (parts.some(part => part === '.' || part === '..' || /[:<>"|?*]/.test(part))) throw new Error('WSL 路径含不支持的路径段。')
  return { distribution: match[1], guestPath: `/${parts.join('/')}` }
}
export function guestPathToHost(distribution: string, path: string): string {
  if (!path.startsWith('/') || posix.normalize(path) !== path || /[\\\0\r\n:<>"|?*]/.test(path)) throw new Error('WSL 路径无法可靠映射到 Windows。')
  return `\\\\wsl.localhost\\${distribution}${path === '/' ? '\\' : path.replaceAll('/', '\\')}`
}
function hostPathEqual(a: string, b: string): boolean {
  const left = parseWslHostPath(a), right = parseWslHostPath(b)
  return Boolean(left && right && left.distribution === right.distribution && left.guestPath === right.guestPath)
}
function hostIdentity(path: string): string {
  const stat = statSync(path, { bigint: true })
  if (!stat.isDirectory()) throw new Error('WSL 工作目录必须是目录。')
  return `${stat.dev}:${stat.ino}`
}
export function checkWslDirectoryMapping(distribution: string, hostCwd: string, output: string[], identity: string): WslExecutionBinding {
  if (output.length !== 3 || !/^\d+:\d+$/.test(output[2]) || !hostPathEqual(output[1], hostCwd) || !hostPathEqual(guestPathToHost(distribution, output[0]), hostCwd)) {
    throw new Error('Linux 与 Windows 的目录映射不一致，已拒绝使用此目录。')
  }
  return { kind: 'wsl', schemaVersion: 1, distribution, hostCwd, guestCwd: output[0], guestRootIdentity: output[2], hostRootIdentity: identity }
}
// All program text is fixed; directory is a positional argument, never shell source.
const INSPECT_DIRECTORY = 'set -eu; p=$(realpath -e -- "$1"); [ -d "$p" ]; printf "%s\\n" "$p"; wslpath -w "$p"; stat -Lc "%d:%i" -- "$p"; command -v setsid >/dev/null; command -v timeout >/dev/null; command -v git >/dev/null'
export function createWslBinding(distribution: string, cwd: string): WslExecutionBinding {
  assertWslDistribution(distribution)
  const parsed = parseWslHostPath(cwd)
  if (!parsed || parsed.distribution !== distribution) throw new Error('请选择该 WSL2 发行版中的 Linux 文件夹（\\\\wsl.localhost\\发行版\\...）；此版本不支持 Windows 盘符或其他共享目录。')
  const hostCwd = realpathSync.native(win32.normalize(cwd))
  const canonical = parseWslHostPath(hostCwd)
  if (!canonical || canonical.distribution !== distribution) throw new Error('WSL 文件夹解析到了另一个执行环境。')
  const output = runWslProbe(['--distribution', distribution, '--exec', '/bin/sh', '-c', INSPECT_DIRECTORY, 'caogen-inspect', canonical.guestPath]).toString('utf8').trimEnd().split(/\r?\n/)
  const binding = checkWslDirectoryMapping(distribution, hostCwd, output, hostIdentity(hostCwd))
  const previous = [...bindings.values()].find(value => hostPathEqual(value.hostCwd, hostCwd))
  if (previous && (previous.guestRootIdentity !== binding.guestRootIdentity || previous.hostRootIdentity !== binding.hostRootIdentity)) {
    throw new Error('此目录已有任务绑定，但其真实身份已变化；已阻止覆盖原环境。请关闭受影响任务并重新启动 EastGenesis 后选择新目录。')
  }
  bindings.set(hostCwd, binding)
  return binding
}
export function assertWslBinding(binding: WslExecutionBinding, cwd = binding.hostCwd): void {
  if (!binding || binding.schemaVersion !== 1 || !hostPathEqual(binding.hostCwd, cwd)) throw new Error('任务的 WSL 工作目录已变化。')
  const fresh = createWslBinding(binding.distribution, cwd)
  if (fresh.guestCwd !== binding.guestCwd || fresh.guestRootIdentity !== binding.guestRootIdentity || fresh.hostRootIdentity !== binding.hostRootIdentity) {
    throw new Error('WSL 发行版或目录身份已变化，原任务环境已失效。')
  }
  bindings.set(fresh.hostCwd, binding)
}
export function resolveTaskExecutionEnvironment(input: {
  cwd: string; selection?: ExecutionEnvironmentSelection; saved?: ExecutionEnvironmentBinding; preferences?: WslPreferences
}): ExecutionEnvironmentBinding {
  if (input.saved) {
    if (input.selection && (input.selection.kind !== input.saved.kind || input.selection.kind === 'wsl' && input.saved.kind === 'wsl' && input.selection.distribution !== input.saved.distribution)) throw new Error('继续任务不能切换已绑定的执行环境。')
    if (input.saved.kind === 'wsl') assertWslBinding(input.saved, input.cwd)
    else if (parseWslHostPath(input.cwd)) throw new Error('宿主机任务不能隐式改用 WSL 目录。')
    return structuredClone(input.saved)
  }
  const parsed = parseWslHostPath(input.cwd)
  const selection = input.selection ?? (input.preferences?.mode === 'wsl' ? { kind: 'wsl' as const, distribution: input.preferences.distribution } : parsed ? { kind: 'wsl' as const, distribution: parsed.distribution } : { kind: 'host' as const })
  if (selection.kind === 'host') {
    if (parsed) throw new Error('WSL 文件夹必须明确使用 WSL 执行环境。')
    return { kind: 'host' }
  }
  if (!selection.distribution) throw new Error('请先在设置中选择 WSL2 发行版。')
  return createWslBinding(selection.distribution, input.cwd)
}
export function wslBindingForCwd(cwd: string): WslExecutionBinding | undefined {
  const parsed = parseWslHostPath(cwd)
  if (!parsed) return undefined
  const candidates = [...bindings.values()].filter(binding => {
    const root = parseWslHostPath(binding.hostCwd)
    return root?.distribution === parsed.distribution && (parsed.guestPath === root.guestPath || parsed.guestPath.startsWith(`${root.guestPath.replace(/\/$/, '')}/`))
  }).sort((a, b) => b.hostCwd.length - a.hostCwd.length)
  let binding = candidates[0]
  if (!binding) {
    // Git may resolve a project subdirectory to its actual repository root.
    // Verify that relationship inside the already-bound distribution first.
    const child = [...bindings.values()].find(value => value.distribution === parsed.distribution && value.guestCwd.startsWith(`${parsed.guestPath.replace(/\/$/, '')}/`))
    if (child) {
      assertWslBinding(child)
      const root = runWslProbe(['--distribution', child.distribution, '--exec', 'git', '-c', 'core.fsmonitor=false', '-C', child.guestCwd, 'rev-parse', '--show-toplevel']).toString('utf8').trim()
      if (root === parsed.guestPath) binding = createWslBinding(child.distribution, cwd)
    }
  }
  if (!binding) throw new Error('此 WSL 目录尚未绑定到经过核对的执行环境，请重新打开任务。')
  assertWslBinding(binding)
  return binding
}
export function assertTaskExecutionEnvironment(meta: { cwd: string; executionEnvironment?: ExecutionEnvironmentBinding }): void {
  if (meta.executionEnvironment?.kind === 'wsl') assertWslBinding(meta.executionEnvironment, meta.cwd)
  else if (parseWslHostPath(meta.cwd)) throw new Error('WSL 任务缺少已固定的执行环境，禁止宿主机回退。')
}
