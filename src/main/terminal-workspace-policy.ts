import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import type { TerminalInfo, WorkspaceTerminalStartInput } from '../shared/terminal-operation-types'

export function normalizeWorkspaceTerminalInput(value: unknown): WorkspaceTerminalStartInput {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('工作区终端参数无效。')
  const input = value as Record<string, unknown>
  if (Object.keys(input).some((key) => !['cwd', 'projectId', 'workspaceId', 'cols', 'rows', 'reuse'].includes(key))) throw new Error('工作区终端只接受目录和窗口尺寸，不接受命令或环境变量。')
  const text = (key: string): string | undefined => {
    const raw = input[key]
    if (raw === undefined) return undefined
    if (typeof raw !== 'string' || !raw.trim() || raw.length > 4096 || /[\0\r\n]/.test(raw)) throw new Error('工作区终端路径或项目身份无效。')
    return raw.trim()
  }
  const dimension = (key: string): number | undefined => {
    if (input[key] === undefined) return undefined
    if (typeof input[key] !== 'number' || !Number.isSafeInteger(input[key]) || Number(input[key]) < 2 || Number(input[key]) > 1000) throw new Error('终端尺寸无效。')
    return Number(input[key])
  }
  if (input.reuse !== undefined && typeof input.reuse !== 'boolean') throw new Error('终端复用参数无效。')
  const result = { cwd: text('cwd'), projectId: text('projectId'), workspaceId: text('workspaceId'), cols: dimension('cols'), rows: dimension('rows'), reuse: input.reuse as boolean | undefined }
  if (result.projectId && result.workspaceId) throw new Error('请选择一种项目身份。')
  return result
}
export function canonicalTerminalDirectory(path: string): string {
  if (!isAbsolute(path) || /[\0\r\n]/.test(path)) throw new Error('请选择绝对目录路径。')
  const directory = realpathSync.native(resolve(path))
  if (!statSync(directory).isDirectory()) throw new Error('终端工作路径必须是目录。')
  return directory
}
export function assertTerminalWindowOwner(terminal: TerminalInfo | undefined, senderId: number): void {
  if (terminal?.ownerWebContentsId !== undefined && terminal.ownerWebContentsId !== senderId) throw new Error('此终端属于另一个窗口，无法读取或控制。')
}
export function terminalVisibleToWindow(terminal: TerminalInfo, senderId: number): boolean {
  return terminal.ownerWebContentsId === undefined || terminal.ownerWebContentsId === senderId
}
