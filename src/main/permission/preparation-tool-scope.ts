import { isAbsolute, join, relative, resolve } from 'node:path'
import type { SessionMeta } from '../../shared/types'
import { PreparationPermissionStore } from './preparation-permission-store'
import { PREPARATION_WRITE_TOOLS } from '../../shared/preparation-permission-types'

export interface PreparationToolPermission { revision: number; directory: string }
export interface PreparationToolScope { cwd: string; preparation?: PreparationToolPermission }
const PREPARATION_TOOLS = new Set<string>([...PREPARATION_WRITE_TOOLS, 'read_file', 'view', 'list_dir'])
export function isPreparationWriteTool(name: string): boolean { return (PREPARATION_WRITE_TOOLS as readonly string[]).includes(name) }
export function isPreparationTool(name: string): boolean { return PREPARATION_TOOLS.has(name) }

/** Relative paths always mean the formal cwd. Only an explicit isolated absolute path selects preparation. */
export function resolvePreparationToolScope(meta: SessionMeta, name: string, input: Record<string, unknown>, rootDir: string): PreparationToolScope {
  const rawPath = name === 'view' ? input.file_path ?? input.path : input.path
  if (typeof rawPath !== 'string' || !isAbsolute(rawPath)) return { cwd: meta.cwd }
  const store = new PreparationPermissionStore(rootDir)
  const target = resolve(rawPath)
  if (!inside(join(store.root, 'preparation-drafts'), target)) return { cwd: meta.cwd }
  if (!PREPARATION_TOOLS.has(name)) throw new Error('此工具未适配独立准备区权限。')
  const permission = store.get(meta)
  if (!permission.available || !permission.directory) throw new Error(permission.unavailableReason ?? '准备区未获授权。')
  if (!inside(permission.directory, target)) throw new Error('准备区目标不属于当前任务授权目录。')
  store.assertWritable(meta, permission.revision, permission.directory, name)
  return { cwd: permission.directory, preparation: { revision: permission.revision, directory: permission.directory } }
}

export function assertPreparationToolScope(meta: SessionMeta, scope: PreparationToolScope, rootDir: string, toolName = 'write_file'): void {
  if (!scope.preparation) return
  if (scope.cwd !== scope.preparation.directory) throw new Error('准备区工具目录与授权目录不一致。')
  new PreparationPermissionStore(rootDir).assertWritable(meta, scope.preparation.revision, scope.preparation.directory, toolName)
}

export function preparationPermissionSystemPrompt(meta: SessionMeta, rootDir: string): string {
  try {
    const permission = new PreparationPermissionStore(rootDir).get(meta)
    if (!permission.available) return ''
    return `用户已另行授予当前任务独立准备区权限（版本 ${permission.revision}）。作为规划策略的明确例外，仅可用 ${permission.allowedWriteTools.join('、')} 在以下隔离目录内起草文件：${permission.directory}。必须使用该目录下的绝对输出路径；read_file、view、list_dir 可读取其中的文件。Office source_refs 可引用原任务目录 ${meta.cwd} 内的资料（相对路径以原任务目录为基准），或用绝对路径引用本准备区草稿。需要修改 Office 草稿时生成新的文件名，保留已有版本。此授权不允许 edit_file、search_replace、命令、正式目录写入或外部操作；不得将起草视为正式执行或最终交付。授权会在写入前复核，撤销后立即停止。`
  } catch { return '准备区授权当前不可验证，禁止向准备区写入。' }
}

function inside(root: string, target: string): boolean {
  const value = relative(root, target)
  return value === '' || (value !== '..' && !value.startsWith('../') && !value.startsWith('..\\') && !isAbsolute(value))
}
