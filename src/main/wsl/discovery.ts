import { execFileSync } from 'node:child_process'
import { win32 } from 'node:path'
import type { WslStatus, WslDistribution } from '../../shared/wsl-types'
import { normalizeWslDistributionName } from '../../shared/wsl-types'
import { buildMinimalSubprocessEnv } from '../security/subprocess-environment'

export interface WslProbeHost {
  platform: string
  run(args: string[]): Buffer | string
}
export function wslExecutable(): string {
  if (process.platform !== 'win32') throw new Error('WSL 运行环境仅支持 Windows。')
  const systemRoot = process.env.SystemRoot
  if (!systemRoot || !win32.isAbsolute(systemRoot)) throw new Error('无法定位 Windows 系统目录。')
  return win32.join(systemRoot, 'System32', 'wsl.exe')
}
export function runWslProbe(args: string[]): Buffer {
  return execFileSync(wslExecutable(), args, { encoding: 'buffer', timeout: 10000, maxBuffer: 128 * 1024,
    env: buildMinimalSubprocessEnv(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
}
export function decodeWslOutput(raw: Buffer | string): string {
  if (typeof raw === 'string') return raw.replace(/^\uFEFF/, '')
  return raw.toString(raw.includes(0) ? 'utf16le' : 'utf8').replace(/^\uFEFF/, '')
}
export function parseWslDistributions(raw: Buffer | string): WslDistribution[] {
  const rows: WslDistribution[] = []
  for (const line of decodeWslOutput(raw).split(/\r?\n/)) {
    const match = /^\s*(\*)?\s*([A-Za-z0-9][A-Za-z0-9._-]{0,127})\s{2,}(.+?)\s{2,}([12])\s*$/.exec(line)
    if (!match || !normalizeWslDistributionName(match[2])) continue
    if (rows.some(row => row.name === match[2])) throw new Error('WSL 发行版清单包含重复条目。')
    rows.push({ name: match[2], state: match[3].trim(), version: Number(match[4]) as 1 | 2, isDefault: Boolean(match[1]) })
  }
  return rows
}
export function inspectWslSync(host: WslProbeHost = { platform: process.platform, run: runWslProbe }): WslStatus {
  const base = { platform: host.platform, checkedAt: Date.now(), available: false, distributions: [] as WslDistribution[] }
  if (host.platform !== 'win32') return { ...base, error: 'WSL2 仅在 Windows 上可用。' }
  try {
    const distributions = parseWslDistributions(host.run(['--list', '--verbose']))
    const names = decodeWslOutput(host.run(['--list', '--quiet'])).split(/\r?\n/).map(value => value.trim()).filter(Boolean)
    if (names.some(name => !distributions.some(row => row.name === name)) || distributions.some(row => !names.includes(row.name))) {
      throw new Error('无法可靠核对 WSL 发行版与版本；请在系统终端检查 wsl --list --verbose。')
    }
    return { ...base, distributions, available: distributions.some(row => row.version === 2),
      ...(!distributions.length ? { error: '未发现已安装的 WSL 发行版。请自行安装 WSL2 后刷新。' }
        : !distributions.some(row => row.version === 2) ? { error: '已安装的发行版均为 WSL1；此功能需要 WSL2。' } : {}) }
  } catch (error) {
    return { ...base, error: error instanceof Error && !('stderr' in error) ? error.message : 'WSL 检测失败或超时；请检查系统中的 WSL 安装。' }
  }
}
export function assertWslDistribution(distribution: string): void {
  if (!normalizeWslDistributionName(distribution)) throw new Error('WSL 发行版名称无效。')
  const status = inspectWslSync()
  if (!status.distributions.some(row => row.name === distribution && row.version === 2)) throw new Error(status.error ?? '指定 WSL2 发行版已不可用；不会切换到其他环境。')
}
