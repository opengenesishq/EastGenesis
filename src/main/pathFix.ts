import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, delimiter } from 'node:path'

/**
 * 修复 GUI 启动时的 PATH 缺失。
 *
 * 根因:macOS(及部分 Linux 桌面)从 Finder/Dock 启动的 GUI 应用 **不继承**
 * 登录 shell 的 PATH,只拿到极简的 `/usr/bin:/bin:/usr/sbin:/sbin`。而用户装的
 * CLI（以及 nvm/homebrew/npm-global 的 node 工具）多在
 * `~/.local/bin`、`/usr/local/bin`、`/opt/homebrew/bin`、`~/.npm-global/bin` 等。
 * 结果:终端启动能探测到 CLI,Dock 启动却报"未安装"——典型只在真实用户环境复现的坑。
 *
 * 取舍:不 spawn 登录 shell 抓 PATH(慢、且各 shell 配置差异大),改为把一组
 * 常见 bin 目录**幂等地**并入 process.env.PATH(去重、仅追加存在的目录)。
 * 必须在任何"探测 CLI 是否安装"的模块(engines.ts 于 import 期即探测)之前调用。
 */

/** 常见的用户级/包管理器 bin 目录(存在才追加)。 */
function candidateBinDirs(): string[] {
  const home = homedir()
  const dirs: string[] = [
    join(home, '.local', 'bin'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    join(home, '.npm-global', 'bin'),
    join(home, '.yarn', 'bin'),
    join(home, '.bun', 'bin'),
    join(home, '.cargo', 'bin'),
    join(home, 'go', 'bin')
  ]
  // nvm 的当前 node 版本目录(若用户用 nvm):~/.nvm/versions/node/*/bin
  // 仅在存在时静态列举,避免遍历开销;缺失则跳过。
  const nvmBin = process.env.NVM_BIN
  if (nvmBin) dirs.push(nvmBin)
  return dirs
}

let applied = false

/** 幂等地把存在的常见 bin 目录并入 process.env.PATH。返回新增的目录数。 */
export function fixPathForGuiLaunch(): number {
  if (applied) return 0
  applied = true
  // Windows 的 PATH 语义不同,且 GUI 启动一般能继承系统 PATH,不处理。
  if (process.platform === 'win32') return 0

  const current = process.env.PATH ?? ''
  const existing = new Set(current.split(delimiter).filter(Boolean))
  const toAdd = candidateBinDirs().filter((dir) => existsSync(dir) && !existing.has(dir))
  if (toAdd.length === 0) return 0
  // 追加到末尾:不覆盖用户/系统已有优先级,只补"找不到才用"的兜底路径。
  process.env.PATH = [current, ...toAdd].filter(Boolean).join(delimiter)
  return toAdd.length
}
